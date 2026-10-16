import subprocess
import time
import stat
import fcntl
from pathlib import Path


class AppCliTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wsl-cli-channel-')
        # macOS /var is a symlink; production guest /tmp is canonical.
        self.path = str(Path(self.temporary.name).resolve() / 'channel')
        self.channel = mcp.AppCliSlots(self.path)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=3)
        self.channel.close()
        self.temporary.cleanup()

    def start_cli(self, args=None, timeout=2):
        source = mcp_source
        program = ('import types,sys,socket\nm=types.ModuleType("cli")\nexec(compile(' + repr(source) +
                   ',"<cli>","exec"),m.__dict__)\n' +
                   'socket.socket=lambda *a,**k: (_ for _ in ()).throw(PermissionError("network sandbox"))\n' +
                   'm.CLI_TIMEOUT=' + repr(timeout) + '\n' +
                   'original=m.cli_channel_call\nm.cli_channel_call=lambda p,n,a: original(p,n,a,' + repr(timeout) + ')\n' +
                   'sys.exit(m.cli_main(sys.argv[1:]))\n')
        env = dict(os.environ, WSL_APP_CHANNEL=self.path, WSL_APP_SOCKET='/never-connect.sock')
        child = subprocess.Popen(['python3', '-I', '-c', program, *(args or ['describe'])],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def poll_until(self, predicate, capacity=4, remaining=64):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.channel.poll(capacity, remaining)
            if predicate(result):
                return result
            time.sleep(.01)
        self.fail('channel stimulus did not arrive')

    def test_channel_is_explicit_and_does_not_connect_socket(self):
        child = self.start_cli()
        calls, _, admitted = self.poll_until(lambda result: bool(result[0]))
        self.assertEqual((calls[0][1], admitted), ({'tool': 'app.describe', 'args': {}}, 1))
        self.channel.finish(calls[0][0], {'ok': True, 'data': {'marker': 7}})
        output, error = child.communicate(timeout=3)
        self.assertEqual((child.returncode, error), (0, ''))
        self.assertEqual(json.loads(output)['data'], {'marker': 7})

    def test_main_error_exit_code_is_preserved(self):
        for code, expected in [('paused_by_user', 1), ('invalid_request', 2)]:
            child = self.start_cli(['ui.act', '{}'])
            calls, _, _ = self.poll_until(lambda result: bool(result[0]))
            self.channel.finish(calls[0][0], {'ok': False, 'error': {'code': code}})
            output, error = child.communicate(timeout=3)
            self.assertEqual((child.returncode, json.loads(output)['error']['code'], error), (expected, code, ''))
            self.channel.poll(4, 64)

    def test_four_slots_and_shared_capacity_budget(self):
        children = [self.start_cli() for _ in range(4)]
        calls = []
        while len(calls) < 4:
            more, _, _ = self.poll_until(lambda result: bool(result[0]), capacity=4-len(calls))
            calls += more
        fifth = self.start_cli()
        output, _ = fifth.communicate(timeout=3)
        self.assertEqual((fifth.returncode, json.loads(output)['error']['code']), (3, 'transport_unavailable'))
        for call_id, _ in calls:
            self.channel.finish(call_id, {'ok': True})
        for child in children:
            child.communicate(timeout=3)
        self.channel.poll(4, 64)
        child = self.start_cli()
        self.poll_until(lambda result: child.poll() is not None, capacity=0)
        output, _ = child.communicate(timeout=3)
        self.assertEqual(child.returncode, 3)
        self.assertEqual(len(self.channel.active), 0)

    def test_run_budget_exhaustion_does_not_forward(self):
        child = self.start_cli()
        calls, _, admitted = self.poll_until(lambda result: child.poll() is not None, remaining=0)
        output, _ = child.communicate(timeout=3)
        self.assertEqual((calls, admitted, child.returncode), ([], 0, 3))
        self.assertIn('budget exhausted', output)

    def test_killed_caller_cancels_and_late_result_cannot_reach_reused_slot(self):
        first = self.start_cli()
        calls, _, _ = self.poll_until(lambda result: bool(result[0]))
        old_id = calls[0][0]
        first.kill()
        first.communicate(timeout=3)
        second = self.start_cli()
        _, cancelled, _ = self.poll_until(lambda result: bool(result[1]))
        self.assertEqual(cancelled, [old_id])
        self.assertFalse(self.channel.finish(old_id, {'ok': True, 'data': 'late'}))
        calls, _, _ = self.poll_until(lambda result: bool(result[0]))
        self.assertNotEqual(calls[0][0], old_id)
        self.channel.finish(calls[0][0], {'ok': True, 'data': 'current'})
        output, _ = second.communicate(timeout=3)
        self.assertEqual(json.loads(output)['data'], 'current')

    def test_client_and_helper_deadlines_cancel(self):
        child = self.start_cli(timeout=.15)
        calls, _, _ = self.poll_until(lambda result: bool(result[0]))
        output, _ = child.communicate(timeout=3)
        self.assertEqual((child.returncode, json.loads(output)['error']['code']), (3, 'transport_unavailable'))
        _, cancelled, _ = self.channel.poll(4, 64)
        self.assertEqual(cancelled, [calls[0][0]])
        child = self.start_cli()
        calls, _, _ = self.poll_until(lambda result: bool(result[0]))
        call_id = calls[0][0]
        slot, _ = self.channel.active[call_id]
        self.channel.active[call_id] = (slot, time.monotonic() - 1)
        self.assertEqual(self.channel.poll(4, 64)[1], [call_id])
        output, _ = child.communicate(timeout=3)
        self.assertEqual(json.loads(output)['error']['code'], 'cancelled')

    def test_symlink_root_and_slot_and_nonregular_lease_rejected(self):
        alias = Path(self.temporary.name) / 'alias'
        alias.symlink_to(self.path, target_is_directory=True)
        with self.assertRaises(OSError):
            mcp.cli_channel_call(str(alias.resolve().parent / 'alias'), 'app.describe', {}, .1)
        slot = Path(self.path) / '0'
        slot.rename(Path(self.path) / 'saved')
        slot.symlink_to(Path(self.path) / 'saved', target_is_directory=True)
        with self.assertRaises(OSError):
            mcp.cli_channel_call(self.path, 'app.describe', {}, .1)
        slot.unlink()
        (Path(self.path) / 'saved').rename(slot)
        (slot / 'lease').unlink()
        os.mkfifo(slot / 'lease', 0o600)
        with self.assertRaises(ValueError):
            mcp.cli_channel_call(self.path, 'app.describe', {}, .1)

    def test_invalid_oversized_and_non_app_frames_never_forwarded(self):
        slot = self.channel.slots[0]
        fd = mcp.channel_open('lease', dir_fd=slot['directory'])
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            for request in [{'id': str(mcp.uuid.uuid4()), 'tool': 'observe.navigate', 'args': {}},
                            {'id': str(mcp.uuid.uuid4()), 'tool': 'app.describe', 'args': []},
                            {'id': str(mcp.uuid.uuid4()), 'tool': 'app.describe', 'args': {'x': 'a'*17000}}]:
                mcp.channel_write(slot['directory'], 'request.json', request)
                self.assertEqual(self.channel.poll(4, 64)[0], [])
            os.unlink('request.json', dir_fd=slot['directory'])
            os.symlink('/etc/passwd', 'request.json', dir_fd=slot['directory'])
            self.assertEqual(self.channel.poll(4, 64)[0], [])
        finally:
            os.close(fd)

    def helper_branch(self, call):
        import ast
        tree = ast.parse(helper_source)
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        branch = next(node for node in ast.walk(main) if isinstance(node, ast.If) and
                      any(isinstance(child, ast.Attribute) and child.attr == call for child in ast.walk(node)))
        # Select the smallest if containing that transport call, not its enclosing loop.
        candidates = [node for node in ast.walk(branch) if isinstance(node, ast.If) and
                      any(isinstance(child, ast.Attribute) and child.attr == call for child in ast.walk(node))]
        branch = min(candidates, key=lambda node: len(list(ast.walk(node))))
        return compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])), '<actual-helper-branch>', 'exec')

    def test_actual_helper_routing_shared_budget_and_cancellation(self):
        child = self.start_cli()
        emitted = []
        namespace = {'cli_channel': self.channel, 'observer_clients': {}, 'observation_count': 63,
                     'emit': lambda kind, **fields: emitted.append({'type': kind, **fields})}
        poll = self.helper_branch('poll')
        deadline = time.monotonic() + 3
        while not emitted and time.monotonic() < deadline:
            exec(poll, namespace)
            time.sleep(.01)
        self.assertEqual(namespace['observation_count'], 64)
        self.assertEqual(emitted[0]['type'], 'observation-call')
        self.assertEqual(emitted[0]['tool'], 'app.describe')
        namespace['frame'] = {'type': 'observation-result', 'id': emitted[0]['id'], 'result': {'ok': True, 'data': 64}}
        exec(self.helper_branch('receive'), namespace)
        output, _ = child.communicate(timeout=3)
        self.assertEqual(json.loads(output)['data'], 64)
        exec(poll, namespace)
        child = self.start_cli()
        deadline = time.monotonic() + 3
        while child.poll() is None and time.monotonic() < deadline:
            exec(poll, namespace)
            time.sleep(.01)
        output, _ = child.communicate(timeout=3)
        self.assertEqual((child.returncode, len(emitted)), (3, 1))
        self.assertEqual(namespace['observation_count'], 64)
        exec(poll, namespace)
        namespace['observation_count'] = 0
        child = self.start_cli()
        deadline = time.monotonic() + 3
        while len(emitted) < 2 and time.monotonic() < deadline:
            exec(poll, namespace)
            time.sleep(.01)
        child.kill()
        child.communicate(timeout=3)
        exec(poll, namespace)
        self.assertEqual(emitted[-1], {'type': 'observation-cancel', 'id': emitted[-2]['id']})

    def test_invalid_identity_frame_and_hardlink_are_explicitly_rejected(self):
        slot = self.channel.slots[0]
        fd = mcp.channel_open('lease', dir_fd=slot['directory'])
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            for request in [[], {'tool': 'app.describe', 'args': {}}, {'id': '-'*36, 'tool': 'app.describe', 'args': {}}]:
                mcp.channel_write(slot['directory'], 'request.json', request)
                self.assertEqual(self.channel.poll(4, 64)[0], [])
                failure = mcp.channel_read(slot['directory'], 'failure.json', 1000)
                self.assertEqual(failure['error']['code'], 'invalid_request')
            os.link('request.json', 'other', src_dir_fd=slot['directory'], dst_dir_fd=slot['directory'])
            with self.assertRaises(ValueError):
                mcp.channel_read(slot['directory'], 'request.json', 16384)
        finally:
            os.close(fd)

    def test_actual_helper_cleanup_failure_retains_owner_and_never_confirms_success(self):
        import ast
        tree = ast.parse(helper_source)
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        closer = next(node for node in ast.walk(main) if isinstance(node, ast.FunctionDef) and node.name == 'close_observers')
        # Only adapt lexical binding to execute the exact nested cleanup body alone.
        closer.body = [ast.Global(names=node.names) if isinstance(node, ast.Nonlocal) else node for node in closer.body]
        class FailedDirectory:
            def cleanup(self):
                raise OSError('injected app channel directory cleanup failure')
        owner = FailedDirectory()
        emitted = []
        namespace = {'cli_channel': None, 'observer': None, 'observer_dir': owner, 'observer_clients': {}, 'research_peers': {},
                     'emit': lambda kind, **fields: emitted.append({'type': kind, **fields})}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[closer], type_ignores=[])), '<actual-helper-close>', 'exec'), namespace)
        with self.assertRaisesRegex(OSError, 'injected'):
            namespace['close_observers']()
        self.assertIs(namespace['observer_dir'], owner)
        outer = next(node for node in main.body if isinstance(node, ast.Try))
        finalizers = [node for node in outer.finalbody if isinstance(node, ast.Try) and
                      any(isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and
                          child.func.id == 'close_observers' for child in ast.walk(node))]
        self.assertEqual(len(finalizers), 1)
        finalizer = finalizers[0]
        self.assertIsInstance(finalizer, ast.Try)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[finalizer], type_ignores=[])), '<actual-helper-finalizer>', 'exec'), namespace)
        self.assertIs(namespace['observer_dir'], owner)
        self.assertEqual(emitted[-1]['type'], 'cleanup')
        self.assertFalse(emitted[-1]['ok'])
        self.assertFalse(any(item.get('ok') is True for item in emitted))
        self.assertIn('injected', emitted[-1]['error'])
