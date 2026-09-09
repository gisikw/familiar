"""Ephemeral native-route operations; no installed service or agent wrapper.
All git arguments remain argv. Account authority is unrestricted. Planning is
read-only; apply/cleanup share a persistent per-job lock and retirement marker.
"""
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

LIMIT = 32768
BUNDLE_NAMES = {'tiamat/index.ts', 'tiamat/catalog.ts', 'tiamat/usage.ts', 'lib/debug.ts'}


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(fd)
        except OSError as exc:
            if exc.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(fd)


def atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.tmp-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise ValueError('not a regular file')
        value = f.read(limit + 1)
    if len(value) > limit:
        raise OverflowError('file bound')
    return value


def read_meta(path):
    return json.loads(read_bytes(path, LIMIT))


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL, timeout=15).decode().strip()


def validate_job(p):
    if not re.fullmatch(r'agent-[a-f0-9-]{36}', p['job_id']):
        raise ValueError('invalid job id')
    if not isinstance(p['nonce'], str) or not p['nonce']:
        raise ValueError('missing correlation nonce')


def current_folder(p):
    root = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state')))
    if not root.is_absolute():
        raise ValueError('XDG state root must be absolute')
    return (root / 'familiar/agents/jobs' / p['job_id']).resolve()


def recorded_folder(p):
    path = Path(p['settlement_path'])
    if not path.is_absolute() or path.name != 'settlement.json' or path.parent.name != p['job_id']:
        raise ValueError('invalid recorded provisioning path')
    return path.parent


def bundle_digest(p):
    if p.get('profile_mode', 'enrolled') != 'familiar-tiamat-v1':
        return None
    bundle = p['profile_bundle']
    if set(bundle) != BUNDLE_NAMES or any(not isinstance(v, str) for v in bundle.values()) or sum(len(v.encode()) for v in bundle.values()) > 36000:
        raise ValueError('invalid credential-free code bundle')
    return hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()


def profile_path(folder, p):
    mode = p.get('profile_mode', 'enrolled')
    if mode == 'familiar-tiamat-v1':
        return folder / 'profile'
    if mode != 'enrolled':
        raise ValueError('unknown worker profile mode')
    path = Path(p['profile'])
    if not path.is_absolute() or not (path / 'settings.json').is_file():
        raise ValueError('explicit enrolled worker profile unavailable')
    return path


def plan(p):
    """No job directory, profile, worktree, lock or marker is created here."""
    folder = current_folder(p)
    repo = Path(p['repo'])
    if not repo.is_absolute():
        raise ValueError('repo must be an absolute enrolled-machine repository path')
    return {
        'remote_worktree': str(folder / 'worktree'),
        'settlement_path': str(folder / 'settlement.json'),
        'remote_profile': str(profile_path(folder, p)),
        'resolved_head': git('-C', str(repo), 'rev-parse', '--verify', '--end-of-options', p['ref'] + '^{commit}'),
        'profile_digest': bundle_digest(p),
    }


def provision_profile(folder, p):
    profile = profile_path(folder, p)
    if p.get('profile_mode', 'enrolled') == 'enrolled':
        return profile
    profile.mkdir(mode=0o700, exist_ok=True)
    for name, content in p['profile_bundle'].items():
        path = profile / 'assets' / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists():
            if read_bytes(path, 36000).decode('utf8') != content:
                raise ValueError('worker profile edited; refusing overwrite')
            continue
        fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.asset-')
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    if not (profile / 'settings.json').exists():
        atomic(profile / 'settings.json', {
            'extensions': [str(profile / 'assets/tiamat')],
            'defaultProjectTrust': 'never', 'lastChangelogVersion': '0.84.1',
        })
    return profile


def provision(folder, p):
    guard = p.get('model_guard_source')
    if not isinstance(guard, str) or not guard or len(guard.encode()) > 8192:
        raise ValueError('bounded model-selection guard required')
    if not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', p['resolved_head']):
        raise ValueError('missing pinned source commit')
    profile = profile_path(folder, p)
    if str(profile) != p['remote_profile'] or bundle_digest(p) != p.get('profile_digest'):
        raise ValueError('durable profile plan mismatch')
    identity = {k: p[k] for k in ['job_id', 'nonce', 'repo', 'ref', 'resolved_head']}
    identity.update(profile=str(profile), profile_mode=p.get('profile_mode', 'enrolled'), profile_digest=p.get('profile_digest'), model_guard_digest=hashlib.sha256(guard.encode()).hexdigest())
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = folder / 'provision.json'
    if marker.exists():
        recorded = read_meta(marker)
        if any(recorded.get(k) != v for k, v in identity.items()):
            raise ValueError('provision identity mismatch')
    else:
        recorded = dict(identity, provisioned=False)
        atomic(marker, recorded)
    binary = p['herdr']
    if not Path(binary).is_absolute() or subprocess.check_output([binary, '--version'], timeout=5).decode().strip() != 'herdr 0.9.0':
        raise ValueError('explicit pinned Herdr 0.9.0 required')
    provision_profile(folder, p)
    guard_path = folder / 'model-guard.ts'
    if guard_path.exists():
        if read_bytes(guard_path, 8192).decode('utf8') != guard:
            raise ValueError('model guard was edited; refusing overwrite')
    else:
        fd, temp = tempfile.mkstemp(dir=folder, prefix='.model-guard.ts.asset-')
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(guard)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, guard_path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    subprocess.run([binary, 'integration', 'install', 'pi'], env={**os.environ, 'PI_CODING_AGENT_DIR': str(profile)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
    repo, wt = p['repo'], folder / 'worktree'
    if not wt.exists():
        if recorded['provisioned']:
            raise ValueError('previously provisioned worktree disappeared; inspect manually')
        git('-C', repo, 'worktree', 'add', '--detach', str(wt), p['resolved_head'])
    common = git('-C', str(wt), 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if common != git('-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'):
        raise ValueError('worktree repository mismatch')
    if not recorded['provisioned']:
        if git('-C', str(wt), 'rev-parse', 'HEAD') != p['resolved_head']:
            raise ValueError('initial worktree commit mismatch')
        recorded['provisioned'] = True
        atomic(marker, recorded)
    return dict(remote_worktree=str(wt), settlement_path=str(folder / 'settlement.json'), remote_profile=str(profile), resolved_head=recorded['resolved_head'], profile_digest=recorded['profile_digest'])


def cleanup(folder, p, retired):
    marker = folder / 'provision.json'
    identity = read_meta(marker) if marker.exists() else None
    if identity and (identity['job_id'] != p['job_id'] or identity['nonce'] != p['nonce']):
        raise ValueError('cleanup identity mismatch')
    if not identity and folder.exists():
        if any(not f.name.startswith('.provision.json.tmp-') or not f.is_file() for f in folder.iterdir()):
            raise ValueError('unidentified retained files; inspect manually')
    if not retired.exists():
        # Persist BEFORE deletion. A delayed old apply can never resurrect this
        # job after cleanup, even across controller generations/route loss.
        atomic(retired, {'job_id': p['job_id'], 'nonce': p['nonce']})
    if not folder.exists():
        return {'complete': True}
    if identity:
        wt = folder / 'worktree'
        registered = ('worktree ' + str(wt)) in git('-C', identity['repo'], 'worktree', 'list', '--porcelain', '-z').split('\0')
        if registered:
            git('-C', identity['repo'], 'worktree', 'remove', '--', str(wt))  # never --force
        elif wt.exists():
            raise ValueError('unregistered worktree contents; inspect manually')
        if identity.get('profile_mode') == 'familiar-tiamat-v1' and (folder / 'profile').exists():
            shutil.rmtree(folder / 'profile')  # this job's generated profile only
        allowed = {'provision.json', 'settlement.json', 'model-guard.ts'}
        for entry in folder.iterdir():
            if entry.name not in allowed and not entry.name.startswith(('.provision.json.tmp-', '.model-guard.ts.asset-')):
                raise ValueError('unexpected retained files; inspect manually')
        for entry in list(folder.iterdir()):
            if entry.name != 'provision.json':
                entry.unlink()
        marker.unlink(missing_ok=True)
    else:
        for entry in folder.iterdir():
            entry.unlink()  # reserved partial provisioning-marker temps only
    folder.rmdir()
    sync_directory(folder.parent)
    return {'complete': True}


def main(p):
    if p['operation'] == 'read':
        try:
            return {'raw': read_bytes(p['path'], LIMIT).decode('utf8')}
        except FileNotFoundError:
            return {'missing': True}
        except OverflowError:
            return {'invalid': 'oversized settlement'}
    validate_job(p)
    if p['operation'] == 'plan':
        return plan(p)
    if p['operation'] not in ('provision', 'cleanup'):
        raise ValueError('unknown native operation')
    if p['operation'] == 'provision':
        folder = recorded_folder(p)  # never re-resolve XDG after durable planning
    else:
        folder = Path(p['path']).parent if p.get('path') else current_folder(p)
        if not folder.is_absolute() or folder.name != p['job_id']:
            raise ValueError('invalid cleanup path')
    folder.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Keep the lock inode outside the deleted directory. Nonblocking acquisition
    # prevents accumulating remote waiters behind an interrupted operation.
    with (folder.parent / (p['job_id'] + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        retired = folder.parent / (p['job_id'] + '.retired.json')
        if retired.exists():
            marker = read_meta(retired)
            if marker != {'job_id': p['job_id'], 'nonce': p['nonce']}:
                raise ValueError('retirement correlation mismatch')
            if p['operation'] == 'provision':
                raise ValueError('provisioning permanently retired')
        return provision(folder, p) if p['operation'] == 'provision' else cleanup(folder, p, retired)


if __name__ == '__main__':
    request = None
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('native input bound')
        request = json.loads(data)
        print(json.dumps(main(request)))
    except Exception:
        # A completed read-only admission check is definitive, unlike a lost
        # route or a provisioning mutation with an unknown outcome. No stderr,
        # credential values, or exception arguments cross this boundary.
        if isinstance(request, dict) and request.get('operation') == 'plan':
            print(json.dumps({'admission_error': 'remote_preflight_failed'}))
            sys.exit(0)
        print(json.dumps({'error': 'native operation failed; inspect enrolled machine'}))
        sys.exit(1)
