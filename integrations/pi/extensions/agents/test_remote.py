import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
AGENTS = Path(__file__).parent
spec = importlib.util.spec_from_file_location('remote', AGENTS / 'remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
BASH = shutil.which('bash') or shutil.which('sh')
JOB = 'agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


def commit(repo, message):
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message, '--allow-empty'], check=True)


def node_eval(script, stdin=None):
    run = subprocess.run(['node', '--input-type=module', '--eval', script], check=True, capture_output=True, text=True, input=stdin)
    return json.loads(run.stdout)


def artifact_of(names, extension='tiamat'):
    return {'extension': extension, 'files': {name: '// credential-free source ' + name for name in names}}


class Native(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        # The harness check runs the account's login shell. The fixture shell
        # records its argv and honours PATH without any node initialisation, so
        # the mechanism is deterministic on every host; real node shell init is
        # node-owned behaviour and is documented, not simulated here.
        self.shell_log = self.root / 'shell-argv.json'
        shell = self.root / 'login-shell'
        shell.write_text('#!' + BASH + '\nprintf "%s\\n" "$@" > ' + json.dumps(str(self.shell_log)) + '\nshift\nexec ' + BASH + ' -c "$@"\n')
        shell.chmod(0o700)
        self.toolchain = self.root / 'toolchain'
        self.toolchain.mkdir()
        (self.toolchain / 'pi').write_text('#!' + BASH + '\nexit 0\n')
        (self.toolchain / 'pi').chmod(0o700)
        self.env = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state'), 'SHELL': str(shell), '__NIXOS_SET_ENVIRONMENT_DONE': '1'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.repo = self.root / "repo O'Brien; $(touch SHOULD_NOT_EXIST)"
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.repo)], check=True)
        commit(self.repo, 'initial')
        self.profile = self.root / 'profile'
        self.profile.mkdir()
        (self.profile / 'settings.json').write_text('{}')
        binary = self.root / 'herdr-fixture'
        binary.write_text('#!' + sys.executable + '\nimport sys\nif sys.argv[1:] == ["--version"]: print("herdr 0.9.0")\n')
        binary.chmod(0o700)
        self.request = dict(herdr=str(binary), model_guard_source='// test-only model guard', operation='provision', job_id=JOB, nonce='nonce', repo=str(self.repo), ref='HEAD', harness='pi', worker_path=str(self.toolchain), profile=str(self.profile))
        self.request.update(remote.main(dict(self.request, operation='plan')))

    def plan_cli(self, request):
        run = subprocess.run([sys.executable, str(AGENTS / 'remote.py')], input=json.dumps(dict(request, operation='plan')).encode(), capture_output=True)
        self.assertEqual(run.stderr, b'')
        return run.returncode, json.loads(run.stdout)

    def test_argv_idempotence_and_no_profile_copy(self):
        paths = remote.main(self.request)
        self.assertEqual(paths, remote.main(self.request))
        wt = Path(paths['remote_worktree'])
        (wt / 'human-edit').write_text('retain')
        self.assertEqual(paths, remote.main(self.request))
        self.assertEqual((wt / 'human-edit').read_text(), 'retain')
        self.assertFalse((wt.parent / 'settings.json').exists())
        self.assertFalse(Path('SHOULD_NOT_EXIST').exists())
        with self.assertRaises(ValueError):
            remote.main(dict(self.request, nonce='other'))

    def test_plan_answers_exactly_project_ref_and_harness(self):
        """The read-only request carries no source, digest or guard, and its
        result carries no digest: the profile artifact is not an admission fact."""
        plan = remote.main(dict(self.request, operation='plan'))
        self.assertEqual(set(plan), {'remote_worktree', 'settlement_path', 'remote_profile', 'resolved_head'})
        self.assertFalse(Path(plan['settlement_path']).parent.exists())
        argv = self.shell_log.read_text().splitlines()
        self.assertEqual(argv[0], '-lc')
        self.assertEqual(argv[-1], 'pi')
        # The login shell was started with the enrolled worker PATH and without
        # an inherited NixOS init marker, exactly as a fresh pane shell starts.
        probe = dict(self.request, operation='plan', harness='probe-env')
        (self.toolchain / 'probe-env').write_text('#!' + BASH + '\n')
        (self.toolchain / 'probe-env').chmod(0o700)
        with patch.object(remote.subprocess, 'run', wraps=remote.subprocess.run) as run:
            remote.main(probe)
        env = run.call_args.kwargs['env']
        self.assertEqual(env['PATH'], str(self.toolchain))
        self.assertNotIn('__NIXOS_SET_ENVIRONMENT_DONE', env)
        # Generated profiles need no enrolled profile path and still never see
        # any artifact during planning.
        generated = dict(self.request, operation='plan', profile_mode='familiar-tiamat-v1')
        generated.pop('profile')
        result = remote.main(generated)
        self.assertEqual(result['remote_profile'], str(Path(result['settlement_path']).parent / 'profile'))
        self.assertNotIn('profile_digest', result)

    def test_typed_preflight_failures_are_specific_and_credential_free(self):
        cases = [
            ('repository_unavailable', dict(repo=str(self.root / 'absent'))),
            ('repository_unavailable', dict(repo=str(self.root))),
            ('ref_unresolvable', dict(ref='no-such-branch')),
            ('ref_unresolvable', dict(ref='-c')),
            ('herdr_unavailable', dict(herdr=str(self.root / 'absent-herdr'))),
            ('harness_unavailable', dict(harness='no-such-harness')),
            ('harness_unavailable', dict(worker_path=str(self.root / 'empty'))),
            ('profile_unavailable', dict(profile=str(self.root / 'absent-profile'))),
            ('request_rejected', dict(job_id='not-a-job')),
            ('request_rejected', dict(repo='relative/path')),
            ('request_rejected', dict(harness='Pi; rm -rf /')),
        ]
        (self.root / 'empty').mkdir()
        for code, override in cases:
            with self.subTest(code=code, override=override):
                status, result = self.plan_cli(dict(self.request, **override))
                self.assertEqual(status, 0)
                self.assertEqual(result, {'admission_error': code})
        self.assertFalse(Path(self.request['settlement_path']).parent.exists())
        wrong_version = self.root / 'herdr-0.8'
        wrong_version.write_text('#!' + BASH + '\necho herdr 0.8.2\n')
        wrong_version.chmod(0o700)
        self.assertEqual(self.plan_cli(dict(self.request, herdr=str(wrong_version)))[1], {'admission_error': 'herdr_unavailable'})
        # A hung repository is an unknown transport outcome, never a verdict.
        with patch.object(remote.subprocess, 'check_output', side_effect=subprocess.TimeoutExpired('git', 15)):
            with self.assertRaises(subprocess.TimeoutExpired):
                remote.main(dict(self.request, operation='plan'))

    def test_detached_linked_checkout_and_branch_refs_resolve_and_provision(self):
        """A same-host tracked checkout (a linked worktree, detached at a commit)
        is a legitimate project path; branch names, HEAD and full commit ids all
        pin the same durable commit and provision from the shared repository."""
        head = remote.git('-C', str(self.repo), 'rev-parse', 'HEAD')
        commit(self.repo, 'second')
        second = remote.git('-C', str(self.repo), 'rev-parse', 'HEAD')
        detached = self.root / 'tracked-checkout'
        remote.git('-C', str(self.repo), 'worktree', 'add', '--detach', str(detached), head)
        for repo, ref, expected in [
            (detached, 'HEAD', head),
            (detached, 'main', second),
            (detached, head, head),
            (self.repo, 'main', second),
            (self.repo, 'refs/heads/main', second),
            (self.repo, head[:12], head),
        ]:
            with self.subTest(repo=repo.name, ref=ref):
                request = dict(self.request, operation='plan', repo=str(repo), ref=ref)
                self.assertEqual(remote.main(request)['resolved_head'], expected)
        request = dict(self.request, repo=str(detached), ref='HEAD')
        request.update(remote.main(dict(request, operation='plan')))
        paths = remote.main(request)
        self.assertEqual(paths['resolved_head'], head)
        self.assertEqual(remote.git('-C', paths['remote_worktree'], 'rev-parse', 'HEAD'), head)
        self.assertEqual(remote.main(dict(operation='cleanup', path=paths['settlement_path'], job_id=JOB, nonce='nonce')), {'complete': True})
        self.assertEqual(remote.git('-C', str(detached), 'rev-parse', 'HEAD'), head)

    def test_atomic_file_contract_and_bounds(self):
        paths = remote.main(self.request)
        path = Path(paths['settlement_path'])
        read = dict(operation='read', path=str(path))
        (path.parent / '.partial-temp').write_text('{')
        self.assertEqual(remote.main(read), {'missing': True})
        remote.atomic(path, {'version': 1})
        self.assertEqual(json.loads(remote.main(read)['raw']), {'version': 1})
        path.write_bytes(b'x' * 32769)
        self.assertIn('invalid', remote.main(read))
        path.unlink()
        path.symlink_to(self.profile / 'settings.json')
        with self.assertRaises(OSError):
            remote.main(read)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(ValueError):
            remote.main(read)

    def test_cleanup_refuses_dirty_then_explicit_retry_succeeds(self):
        paths = remote.main(self.request)
        wt = Path(paths['remote_worktree'])
        edit = wt / 'human-edit'
        edit.write_text('retain')
        cleanup = dict(operation='cleanup', path=paths['settlement_path'], job_id=self.request['job_id'], nonce='nonce')
        with self.assertRaises(subprocess.CalledProcessError):
            remote.main(cleanup)
        self.assertTrue(edit.exists())
        edit.unlink()
        self.assertEqual(remote.main(cleanup), {'complete': True})
        self.assertEqual(remote.main(cleanup), {'complete': True})

    def generated(self, artifact):
        request = dict(self.request, profile_mode='familiar-tiamat-v1', profile_artifact=artifact, profile_digest=remote.artifact_digest(artifact))
        request.pop('profile')
        request.update(remote.main(dict(request, operation='plan')))
        return request

    def test_generated_profile_installs_exactly_the_pinned_artifact(self):
        (self.profile / 'auth.json').write_text('DO_NOT_COPY_AMBIENT_AUTH')
        artifact = artifact_of(['tiamat/index.ts', 'tiamat/catalog.ts', 'tiamat/deep/nested/helper.ts', 'lib/debug.ts'])
        request = self.generated(artifact)
        paths = remote.main(request)
        generated = Path(paths['remote_profile'])
        self.assertNotEqual(generated, self.profile)
        self.assertEqual(paths['profile_digest'], request['profile_digest'])
        self.assertFalse((generated / 'auth.json').exists())
        installed = sorted(str(f.relative_to(generated / 'assets')) for f in (generated / 'assets').rglob('*') if f.is_file())
        self.assertEqual(installed, sorted(artifact['files']))
        settings = json.loads((generated / 'settings.json').read_text())
        self.assertEqual(settings['extensions'], [str(generated / 'assets/tiamat')])
        self.assertEqual(settings['defaultProjectTrust'], 'never')
        self.assertEqual(remote.main(request), paths)
        edited = dict(artifact, files=dict(artifact['files'], **{'lib/debug.ts': 'changed'}))
        with self.assertRaises(ValueError):
            remote.main(dict(request, profile_artifact=edited, profile_digest=remote.artifact_digest(edited)))
        remote.main(dict(operation='cleanup', path=paths['settlement_path'], job_id=request['job_id'], nonce=request['nonce']))
        self.assertFalse(generated.exists())
        self.assertEqual((self.profile / 'auth.json').read_text(), 'DO_NOT_COPY_AMBIENT_AUTH')

    def test_artifact_is_generic_bounded_and_traversal_safe(self):
        """No filename list: any safe relative .ts graph is accepted, so a newly
        imported module can never brick dispatch; unsafe or unbounded sets are
        refused by shape alone."""
        for names in [['tiamat/index.ts'], ['tiamat/index.ts', 'tiamat/new-module.ts', 'lib/other.ts'], ['tiamat/index.ts'] + ['tiamat/m%d.ts' % i for i in range(31)]]:
            self.assertRegex(remote.artifact_digest(artifact_of(names)), r'^[a-f0-9]{64}$')
        rejected = [
            artifact_of(['tiamat/index.ts', '../escape.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat/../../escape.ts']),
            artifact_of(['tiamat/index.ts', '/etc/passwd']),
            artifact_of(['tiamat/index.ts', 'tiamat//double.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat/./dot.ts']),
            artifact_of(['tiamat/index.ts', '.hidden/index.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat\\windows.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat/a/b/c/d/e/too-deep.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat/index.ts/child.ts']),
            artifact_of(['tiamat/index.ts', 'tiamat/' + 'x' * 65 + '.ts']),
            artifact_of(['tiamat/index.ts'] + ['tiamat/m%d.ts' % i for i in range(32)]),
            artifact_of(['tiamat/catalog.ts']),
            artifact_of(['tiamat/index.ts'], extension='../tiamat'),
            artifact_of(['tiamat/index.ts'], extension='lib'),
            dict(artifact_of(['tiamat/index.ts']), extra=True),
            {'extension': 'tiamat', 'files': {'tiamat/index.ts': 'x\0y'}},
            {'extension': 'tiamat', 'files': {'tiamat/index.ts': 7}},
            {'extension': 'tiamat', 'files': {}},
            {'extension': 'tiamat', 'files': {'tiamat/index.ts': 'x' * (remote.ARTIFACT_LIMIT + 1)}},
            {'extension': 'tiamat', 'files': {'tiamat/index.ts': 'x' * 40000, 'lib/debug.ts': 'y' * 30000}},
            'not-an-object',
        ]
        for artifact in rejected:
            with self.subTest(artifact=str(artifact)[:80]):
                with self.assertRaises(ValueError):
                    remote.artifact_digest(artifact)
        # Every refusal also holds on the controller, from the same rules.
        contract = (AGENTS / 'contract.mjs').as_uri()
        outcomes = node_eval(f'''
import {{ profileArtifact, artifactDigest }} from {json.dumps(contract)};
import {{ readFileSync }} from "node:fs";
const cases = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(cases.map((a) => {{ try {{ return artifactDigest(profileArtifact(a)); }} catch {{ return null; }} }})));
''', stdin=json.dumps(rejected))
        self.assertEqual(outcomes, [None] * len(rejected))
        # Provisioning refuses a rejected or mismatched artifact definitively,
        # before any lock, directory or marker exists.
        request = self.generated(artifact_of(['tiamat/index.ts', 'lib/debug.ts']))
        folder = Path(request['settlement_path']).parent
        for bad in [dict(request, profile_artifact=artifact_of(['tiamat/index.ts', '../escape.ts'])), dict(request, profile_digest='0' * 64)]:
            run = subprocess.run([sys.executable, str(AGENTS / 'remote.py')], input=json.dumps(bad).encode(), capture_output=True)
            self.assertEqual(run.returncode, 0)
            self.assertEqual(json.loads(run.stdout), {'provision_error': 'profile_artifact_rejected'})
            self.assertEqual(run.stderr, b'')
        self.assertFalse(folder.exists())
        self.assertEqual(list(folder.parent.iterdir()) if folder.parent.exists() else [], [])

    def test_ref_is_pinned_across_death_before_worktree_creation(self):
        git = remote.git
        def interrupted(*args):
            if 'worktree' in args and 'add' in args:
                raise RuntimeError('simulated death')
            return git(*args)
        head = git('-C', str(self.repo), 'rev-parse', 'HEAD')
        with patch.object(remote, 'git', interrupted):
            with self.assertRaises(RuntimeError):
                remote.main(self.request)
        commit(self.repo, 'branch moved')
        paths = remote.main(self.request)
        self.assertEqual(paths['resolved_head'], head)
        self.assertEqual(git('-C', paths['remote_worktree'], 'rev-parse', 'HEAD'), head)

    def test_planning_is_read_only_and_apply_uses_the_recorded_xdg_path(self):
        folder = Path(self.request['settlement_path']).parent
        self.assertFalse(folder.exists())
        with patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'changed-state')}):
            result = remote.main(self.request)
        self.assertEqual(result['settlement_path'], self.request['settlement_path'])
        self.assertTrue(folder.exists())
        cleanup = dict(operation='cleanup', path=result['settlement_path'], job_id=self.request['job_id'], nonce='nonce')
        lock_path = folder.parent / (self.request['job_id'] + '.lock')
        with lock_path.open('a') as lock:
            remote.fcntl.flock(lock, remote.fcntl.LOCK_EX | remote.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                remote.main(cleanup)
        self.assertTrue((folder / 'worktree').exists())
        remote.main(cleanup)
        self.assertTrue((folder.parent / (self.request['job_id'] + '.retired.json')).exists())
        with self.assertRaises(ValueError):
            remote.main(self.request)

    def test_cleanup_death_after_marker_removal_is_retryable(self):
        paths = remote.main(self.request)
        cleanup = dict(operation='cleanup', path=paths['settlement_path'], job_id=self.request['job_id'], nonce='nonce')
        with patch.object(Path, 'rmdir', side_effect=RuntimeError('death before final rmdir')):
            with self.assertRaises(RuntimeError):
                remote.main(cleanup)
        self.assertEqual(remote.main(cleanup), {'complete': True})
        with self.assertRaises(ValueError):
            remote.main(self.request)  # a delayed old apply must never resurrect it
        # Partial/unstarted provisioning can also be explicitly cleaned without
        # inventing an absolute path from the controller's own XDG root.
        self.assertEqual(remote.main(dict(cleanup, path=None)), {'complete': True})

    def test_real_controller_artifact_round_trips_with_identical_digest(self):
        """The controller's real artifact and digest are the regression fixture:
        both sides must agree on digest bytes and both request shapes must fit,
        whatever the current module graph is. No names are asserted here."""
        controller = node_eval(f'''
import {{ workerProfileArtifact, provisionRequest, nativeInput, Transport }} from {json.dumps((AGENTS / 'transport.mjs').as_uri())};
import {{ LIMITS, artifactDigest }} from {json.dumps((AGENTS / 'contract.mjs').as_uri())};
const artifact = workerProfileArtifact();
process.stdout.write(JSON.stringify({{ artifact, digest: artifactDigest(artifact), nativeRequestLimit: LIMITS.nativeRequest, artifactLimit: LIMITS.artifact, artifactFiles: LIMITS.artifactFiles, artifactDepth: LIMITS.artifactDepth }}));
''')
        artifact = controller['artifact']
        self.assertEqual(remote.artifact_digest(artifact), controller['digest'])
        self.assertEqual((controller['nativeRequestLimit'], controller['artifactLimit'], controller['artifactFiles'], controller['artifactDepth']), (remote.NATIVE_INPUT_LIMIT, remote.ARTIFACT_LIMIT, remote.ARTIFACT_FILES, remote.ARTIFACT_DEPTH))
        self.assertTrue(all(name.endswith('.ts') for name in artifact['files']))
        self.assertIn('tiamat/index.ts', artifact['files'])
        request = self.generated(artifact)
        serialized = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode()
        self.assertLessEqual(len(serialized), remote.NATIVE_INPUT_LIMIT)
        run = subprocess.run([sys.executable, str(AGENTS / 'remote.py')], input=serialized, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertEqual(json.loads(run.stdout)['profile_digest'], controller['digest'])
        self.assertEqual(run.stderr, b'')
        too_large = subprocess.run([sys.executable, str(AGENTS / 'remote.py')], input=b' ' * (remote.NATIVE_INPUT_LIMIT + 1), capture_output=True)
        self.assertEqual(too_large.returncode, 1)
        self.assertEqual(json.loads(too_large.stdout), {'error': 'native operation failed; inspect enrolled machine'})
        self.assertEqual(too_large.stderr, b'')


if __name__ == '__main__':
    unittest.main()
