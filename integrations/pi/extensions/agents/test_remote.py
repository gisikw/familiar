import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)

class Native(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.repo = self.root / "repo O'Brien; $(touch SHOULD_NOT_EXIST)"
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial', '--allow-empty'], check=True)
        self.profile = self.root / 'profile'
        self.profile.mkdir()
        (self.profile / 'settings.json').write_text('{}')
        binary = self.root / 'herdr-fixture'
        binary.write_text('#!' + sys.executable + '\nimport sys\nif sys.argv[1:] == ["--version"]: print("herdr 0.9.0")\n')
        binary.chmod(0o700)
        self.request = dict(herdr=str(binary), model_guard_source='// test-only model guard', operation='provision', job_id='agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nonce='nonce', repo=str(self.repo), ref='HEAD', profile=str(self.profile))
        self.request.update(remote.main(dict(self.request, operation='plan')))

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

    def test_read_only_admission_failure_is_typed_and_credential_free(self):
        request = dict(self.request, operation='plan', profile=str(self.root / 'absent-profile'))
        run = subprocess.run([sys.executable, str(Path(__file__).with_name('remote.py'))], input=json.dumps(request), text=True, capture_output=True)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(json.loads(run.stdout), {'admission_error': 'remote_preflight_failed'})
        self.assertEqual(run.stderr, '')
        self.assertFalse(Path(request['settlement_path']).parent.exists())

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

    def test_generated_tiamat_profile_copies_only_explicit_code_bundle(self):
        (self.profile / 'auth.json').write_text('DO_NOT_COPY_AMBIENT_AUTH')
        bundle = {name: '// credential-free source' for name in ['tiamat/index.ts', 'tiamat/catalog.ts', 'tiamat/materializer.ts', 'tiamat/usage.ts', 'lib/debug.ts']}
        request = dict(self.request, profile_mode='familiar-tiamat-v1', profile_bundle=bundle)
        request.update(remote.main(dict(request, operation='plan')))
        paths = remote.main(request)
        generated = Path(paths['remote_profile'])
        self.assertNotEqual(generated, self.profile)
        self.assertFalse((generated / 'auth.json').exists())
        settings = json.loads((generated / 'settings.json').read_text())
        self.assertEqual(settings['extensions'], [str(generated / 'assets/tiamat')])
        self.assertEqual(settings['defaultProjectTrust'], 'never')
        self.assertEqual(remote.main(request), paths)
        with self.assertRaises(ValueError):
            remote.main(dict(request, profile_bundle=dict(bundle, **{'lib/debug.ts': 'changed'})))
        remote.main(dict(operation='cleanup', path=paths['settlement_path'], job_id=request['job_id'], nonce=request['nonce']))
        self.assertFalse(generated.exists())
        self.assertEqual((self.profile / 'auth.json').read_text(), 'DO_NOT_COPY_AMBIENT_AUTH')

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
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'branch moved', '--allow-empty'], check=True)
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

    def test_real_profile_bundle_against_remote_validation(self):
        """Regression: ensure transport.mjs workerProfileBundle() matches remote.py acceptance.
        This test fails if workerProfileBundle() gains/loses files without updating BUNDLE_NAMES
        or if the total size exceeds BUNDLE_LIMIT, preventing all familiar-tiamat-v1 jobs.
        """
        # The authoritative list of bundle files comes from transport.mjs workerProfileBundle().
        # These must match BUNDLE_NAMES in remote.py exactly.
        expected_files = [
            'tiamat/index.ts',
            'tiamat/catalog.ts',
            'tiamat/materializer.ts',
            'tiamat/usage.ts',
            'lib/debug.ts',
        ]
        
        # Verify BUNDLE_NAMES contains exactly these files
        self.assertEqual(
            remote.BUNDLE_NAMES,
            set(expected_files),
            f"BUNDLE_NAMES mismatch: {remote.BUNDLE_NAMES} vs {set(expected_files)}"
        )
        
        # Load actual file contents and test bundle_digest validation
        # Bundle files are in the parent extensions directory, not in agents/
        extensions_dir = Path(__file__).parent.parent
        bundle = {}
        total_size = 0
        for filename in expected_files:
            filepath = extensions_dir / filename
            self.assertTrue(
                filepath.exists(),
                f"Bundle file does not exist: {filepath}"
            )
            content = filepath.read_text()
            bundle[filename] = content
            total_size += len(content.encode())
        
        # Verify total size is within BUNDLE_LIMIT
        self.assertLessEqual(
            total_size,
            remote.BUNDLE_LIMIT,
            f"Bundle total size {total_size} exceeds BUNDLE_LIMIT {remote.BUNDLE_LIMIT}"
        )
        
        # Test that bundle_digest accepts the real bundle
        request = dict(
            self.request,
            profile_mode='familiar-tiamat-v1',
            profile_bundle=bundle
        )
        # This should not raise ValueError
        digest = remote.bundle_digest(request)
        self.assertIsNotNone(digest)
        self.assertRegex(digest, r'^[a-f0-9]{64}$', "Invalid SHA256 digest format")
        
        # Verify plan accepts it
        try:
            plan_result = remote.plan(request)
            self.assertIn('profile_digest', plan_result)
            self.assertEqual(plan_result['profile_digest'], digest)
        except ValueError as e:
            self.fail(f"plan() rejected valid profile_bundle: {e}")
        
        # Verify rejection of oversized bundles
        oversized = dict(bundle)
        oversized['lib/debug.ts'] = oversized['lib/debug.ts'] + 'x' * remote.BUNDLE_LIMIT
        with self.assertRaises(ValueError):
            remote.bundle_digest(dict(request, profile_bundle=oversized))
        
        # Verify rejection of missing files
        incomplete = {k: v for k, v in bundle.items() if k != 'tiamat/materializer.ts'}
        with self.assertRaises(ValueError):
            remote.bundle_digest(dict(request, profile_bundle=incomplete))
        
        # Verify rejection of extra files
        extra = dict(bundle, **{'tiamat/extra.ts': '// should not be here'})
        with self.assertRaises(ValueError):
            remote.bundle_digest(dict(request, profile_bundle=extra))

if __name__ == '__main__':
    unittest.main()
