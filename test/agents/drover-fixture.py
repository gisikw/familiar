"""Test-only isolated Drover registry/control stream + two disposable SSH endpoints.
Imports unchanged Drover primitives. Never reads any operator credentials.
"""
import asyncio
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import sys
from aiohttp import web, ClientSession
sys.path.insert(0, sys.argv[2])
from drover import Coordinator, local_rpc, private_write

root = Path(sys.argv[1])
params = json.loads((root / 'fixture-input.json').read_text())
ssh = str(Path(params['sshd']).parent)
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

async def main():
    user = pwd.getpwuid(os.getuid()).pw_name
    for key in ['operator', 'jump-host', 'node-host']:
        subprocess.run([ssh + '/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / key)], check=True)
    node_port, jump_port = port(), port()
    daemons = []
    for name, listen, extra in [('node', node_port, 'AllowTcpForwarding no\n'), ('jump', jump_port, f'AllowTcpForwarding local\nPermitOpen 127.0.0.1:{node_port}\nMaxSessions 0\n')]:
        cfg = root / (name + '-sshd.conf')
        cfg.write_text(f'''ListenAddress 127.0.0.1
Port {listen}
HostKey {root}/{name}-host
PidFile {root}/{name}-sshd.pid
AuthorizedKeysFile {root}/operator.pub
AllowUsers {user}
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowAgentForwarding no
X11Forwarding no
SetEnv PATH={params['path']} XDG_STATE_HOME={root}/state
{extra}''')
        log = (root / (name + '-sshd.log')).open('w')
        daemons.append(subprocess.Popen([ssh + '/sshd', '-D', '-e', '-f', str(cfg)], stdout=log, stderr=log))
    private_write(root / 'operator.conf', f'Host *\n  IdentityFile {root}/operator\n  IdentitiesOnly yes\n')
    enrollment, client = os.urandom(32).hex(), os.urandom(32).hex()
    private_write(root / 'client-token', client)
    c = Coordinator(str(root / 'drover-registry'), enrollment, client, node_port)
    runner = web.AppRunner(c.app())
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    url = 'http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1])
    key = (root / 'node-host.pub').read_text().strip()
    machine = dict(name='local-proof', session='fa-proof', ssh_user=user, host_key=key)
    stopped = asyncio.Event()
    for sig in [signal.SIGTERM, signal.SIGINT]:
        asyncio.get_running_loop().add_signal_handler(sig, stopped.set)
    try:
        async with ClientSession() as http:
            async with http.post(url + '/v1/machines/register', headers={'Authorization': 'Bearer ' + enrollment}, json=machine) as r:
                r.raise_for_status()
                identity = await r.json()
            machine.update(port=node_port, ssh_alias='drover-local-proof', profile=str(root / 'profile'), herdr_binary=params['herdr'], python_binary=params['python'], profile_mode='enrolled', models=[params['model']], worker_env=params['worker_env'])
            config = dict(url=url, token_file=str(root / 'client-token'), ssh_config=str(root / 'operator.conf'), jump=dict(alias='proof-jump',hostname='127.0.0.1',port=jump_port,user=user,host_key=(root / 'jump-host.pub').read_text().strip()), machines=[machine],remote_retention_days=0)
            private_write(root / 'agents-config.json', json.dumps(config))
            async def node():
                while not stopped.is_set():
                    if (root / 'disconnect').exists():
                        await asyncio.sleep(.2)
                        continue
                    async with http.ws_connect(url + '/v1/machines/local-proof/control', headers={'Authorization': 'Bearer ' + identity['token']}) as ws:
                        async def forward():
                            async for msg in ws:
                                request = json.loads(msg.data)
                                response = await local_rpc(params['socket'], request)
                                await ws.send_json({'id': request['id'], 'response': response})
                        work = asyncio.create_task(forward())
                        while not stopped.is_set() and not (root / 'disconnect').exists():
                            await asyncio.sleep(.1)
                        work.cancel()
                        await asyncio.gather(work, return_exceptions=True)
            work = asyncio.create_task(node())
            await asyncio.sleep(.5)
            if any(p.poll() is not None for p in daemons):
                raise RuntimeError('isolated sshd failed; inspect test-only logs')
            (root / 'fixture-ready').write_text('ready')
            await stopped.wait()
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
    finally:
        await runner.cleanup()
        c.db.close()
        for p in daemons:
            p.terminate()
            p.wait(timeout=10)
        # Retain evidence, not disposable authentication material. These keys and
        # tokens were generated solely for these now-stopped test endpoints.
        for name in ['operator', 'jump-host', 'node-host', 'client-token']:
            (root / name).unlink(missing_ok=True)

asyncio.run(main())
