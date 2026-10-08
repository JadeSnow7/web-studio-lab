import ast
import copy
import json
import os
import socket
import tempfile
import threading
import unittest

class ObservationSocketTests(unittest.TestCase):
    def test_actual_unix_socket_bounded_read_and_scoped_source_list(self):
        received = []
        errors = []
        with tempfile.TemporaryDirectory(prefix='wsl-observation-socket-') as root:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            path = os.path.join(root, 'read.sock')
            server.bind(path)
            server.listen(1)
            server.settimeout(5)
            def serve():
                try:
                    for index in range(2):
                        client, _ = server.accept()
                        with client, client.makefile('rb') as stream:
                            request = json.loads(stream.readline(16385))
                            received.append(request)
                            data = {'kind': 'sources', 'workspaceId': 'frozen-space', 'sources': []} if index == 0 else {'error': 'stale_cursor', 'message': 'changed'}
                            client.sendall((json.dumps(data) + '\n').encode())
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=serve)
            thread.start()
            previous = mcp.OBSERVATION_SOCKET
            mcp.OBSERVATION_SOCKET = path
            try:
                observed = mcp.observe('workspace.list_sources', {})
                self.assertEqual(observed['structuredContent']['data']['workspaceId'], 'frozen-space')
                stale = mcp.observe('files.read', {'resourceId': 'file-a', 'cursor': 'old'})
                self.assertTrue(stale['isError'])
                self.assertEqual(stale['structuredContent']['data']['error'], 'stale_cursor')
                with self.assertRaises(mcp.RpcError):
                    mcp.observe('files.read', {'path': '中' * 6000})
            finally:
                mcp.OBSERVATION_SOCKET = previous
                thread.join(6)
                server.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, [{'tool': 'workspace.list_sources', 'args': {}}, {'tool': 'files.read', 'args': {'resourceId': 'file-a', 'cursor': 'old'}}])

    def test_disconnected_guest_client_emits_cancel_and_leaves_other_client_usable(self):
        # Exercise the exact delivery branch without launching the Linux-only process owner.
        tree = ast.parse(helper_source)
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        branch = next(node for node in ast.walk(main) if isinstance(node, ast.If)
                      and any(isinstance(child, ast.Constant) and child.value == 'observation-result' for child in ast.walk(node.test)))
        delivery = compile(ast.fix_missing_locations(ast.Module(body=[copy.deepcopy(branch)], type_ignores=[])), '<guest-delivery>', 'exec')
        disconnected, gone = socket.socketpair()
        healthy, receiver = socket.socketpair()
        emitted = []
        clients = {'disconnected': (disconnected, None, 0), 'healthy': (healthy, None, 0)}
        namespace = {'json': json, 'kind': 'observation-result', 'terminal': False, 'observer_clients': clients,
                     'emit': lambda kind, **fields: emitted.append({'type': kind, **fields}),
                     'frame': {'id': 'disconnected', 'result': {'error': 'not_found', 'message': 'result'}}}
        gone.close()
        try:
            exec(delivery, namespace)
            self.assertEqual(emitted, [{'type': 'observation-cancel', 'id': 'disconnected'}])
            self.assertEqual(disconnected.fileno(), -1)
            self.assertIn('healthy', clients)
            namespace['frame'] = {'id': 'healthy', 'result': {'kind': 'sources', 'workspaceId': 'frozen-space', 'sources': []}}
            exec(delivery, namespace)
            receiver.settimeout(1)
            self.assertEqual(json.loads(receiver.recv(4096))['workspaceId'], 'frozen-space')
            self.assertEqual(clients, {})
        finally:
            disconnected.close()
            healthy.close()
            receiver.close()

    def test_full_request_frame_budget_is_rejected_before_connecting(self):
        received = []
        errors = []
        stop = threading.Event()
        with tempfile.TemporaryDirectory(prefix='wsl-observation-frame-') as root:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            path = os.path.join(root, 'read.sock')
            server.bind(path)
            server.listen(1)
            server.settimeout(0.05)
            def serve():
                try:
                    while not stop.is_set():
                        try:
                            client, _ = server.accept()
                        except socket.timeout:
                            continue
                        with client, client.makefile('rb') as stream:
                            received.append(stream.readline(20000))
                            client.sendall(b'{"error":"unavailable","message":"oversized frame"}\n')
                        return
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=serve)
            thread.start()
            previous = mcp.OBSERVATION_SOCKET
            mcp.OBSERVATION_SOCKET = path
            # Arguments fit exactly, while tool/envelope/newline exceed the guest frame budget.
            args = {'path': 'x' * (16384 - len(json.dumps({'path': ''}, ensure_ascii=False).encode()))}
            self.assertEqual(len(json.dumps(args, ensure_ascii=False).encode()), 16384)
            try:
                with self.assertRaises(mcp.RpcError) as rejected:
                    mcp.observe('files.read', args)
                self.assertEqual(rejected.exception.code, -32602)
            finally:
                mcp.OBSERVATION_SOCKET = previous
                stop.set()
                thread.join(1)
                server.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, [])

result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ObservationSocketTests))
if not result.wasSuccessful():
    raise SystemExit(1)
