"""Standard-library tests. Caller supplies the real module as mcp; no model calls."""
import copy
import contextlib
import errno
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


def fixture_bundle():
    body = "Example Domain\nThis domain is for use in illustrative examples in documents."
    snapshot = {"page": {"webContentsId": 2, "documentGeneration": 3, "url": "https://example.com/", "title": "Example Domain", "partition": "persist:wsl-preview"}, "requestedUrl": "https://example.com/", "url": "https://example.com/", "title": "Example Domain", "text": body, "capturedAt": "2026-10-06T12:00:00.000Z", "sourceSha256": "a" * 64, "contentSha256": hashlib.sha256(body.encode()).hexdigest(), "extractionVersion": "html-text-v1", "truncated": False}
    revision = {key: snapshot[key] for key in ("text", "capturedAt", "sourceSha256", "contentSha256", "truncated")}
    revision.update(resourceId="e6b3d0b2-891e-4f7b-a49b-5990aef2b911", version=1, evidence={"kind": "web", "snapshot": snapshot})
    return {"conversationId": "conv-space-taskflow-demo-impl", "sessionId": "conv-space-taskflow-demo-impl", "accountId": "test-account", "generation": "generation-1", "turnId": "turn-1", "workspaceId": "taskflow-demo", "catalogRevision": 1, "resources": [revision]}


def guest_fixture_bundle():
    bundle = fixture_bundle()
    record = bundle["resources"][0]["evidence"]["snapshot"]
    record.update(extractionVersion="rendered-dom-text-v1", sourceKind="decoded-main-response", captureId="9106578b-e2ce-4c19-a8b7-06753245eaa5", screenshotSha256="c" * 64)
    record["page"] = {"kind": "sandbox-chromium", "sandboxName": "wsl-sbx-smoke-20261006", "browserInstanceId": "5cd9a82c-d94e-4774-854d-e58083e49e9b", "targetId": "CDP-TARGET-1", "navigationEpoch": 1, "url": record["url"], "title": record["title"]}
    return bundle


class ResourceMcpTests(unittest.TestCase):
    def test_exact_list_and_read(self):
        bundle = fixture_bundle()
        mcp.validate_bundle(bundle)
        listed = mcp.dispatch(bundle, "tools/call", {"name": "list_resources", "arguments": {}})["structuredContent"]
        self.assertTrue(listed["untrusted"])
        resource = listed["data"]["resources"][0]
        self.assertNotIn("text", resource)
        read = mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": resource["resourceId"], "version": 1}})["structuredContent"]
        self.assertEqual(read["data"]["text"], bundle["resources"][0]["text"])
        self.assertTrue(read["untrusted"])
        tools = mcp.dispatch(bundle, "tools/list", {})["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["list_resources", "read_resource"])
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] and not tool["annotations"]["destructiveHint"] for tool in tools))

    def test_dynamic_host_registered_conversation_bundle(self):
        bundle = fixture_bundle()
        bundle.update(conversationId="session-dynamic", sessionId="session-dynamic", workspaceId="another-workspace")
        mcp.validate_bundle(bundle)
        listed = mcp.dispatch(bundle, "tools/call", {"name": "list_resources", "arguments": {}})["structuredContent"]["data"]
        self.assertEqual(listed["workspaceId"], "another-workspace")
        self.assertEqual(len(listed["resources"]), 1)
        personal = copy.deepcopy(bundle)
        personal.update(conversationId="conv-personal-default", sessionId="conv-personal-default", workspaceId=None)
        mcp.validate_bundle(personal)
        self.assertEqual(len(personal["resources"]), 1)
        for mutate in [lambda b: b.update(sessionId="other"), lambda b: b.update(conversationId="session-../file", sessionId="session-../file"), lambda b: b.update(workspaceId="../other"), lambda b: b.update(conversationId="conv-personal-default", sessionId="conv-personal-default")]:
            invalid = copy.deepcopy(bundle)
            mutate(invalid)
            with self.subTest(bundle=invalid), self.assertRaises(ValueError):
                mcp.validate_bundle(invalid)

    def test_observed_codex_metadata_envelope_grants_no_capability(self):
        bundle = fixture_bundle()
        # Actual Codex 0.160.0 failure shape: tools/list params is an object with only _meta.
        # Values here are fictional; the observation retained key names and types only.
        metadata = {"_meta": {"progressToken": "fixture-42", "fixtureTrace": {"permission": "write"}}}
        self.assertEqual(mcp.dispatch(bundle, "tools/list", metadata), mcp.dispatch(bundle, "tools/list", {}))
        self.assertEqual(mcp.dispatch(bundle, "ping", metadata), {})
        for params in [{"_meta": None}, {"_meta": "fixture"}, {"_meta": []}, {"_meta": {}, "spaceId": "other"}, {"cursor": "invented-page"}]:
            for method in ("tools/list", "ping"):
                with self.subTest(params=params, method=method), self.assertRaises(mcp.RpcError):
                    mcp.dispatch(bundle, method, params)
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "tools/call", {"name": "write_resource", "arguments": {}, **metadata})
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "tools/call", {"name": "list_resources", "arguments": {"path": "/etc/passwd"}, **metadata})
        self.assertEqual(mcp.dispatch(bundle, "tools/call", {"name": "list_resources", "arguments": {}, **metadata})["structuredContent"]["data"]["workspaceId"], "taskflow-demo")

    def test_no_unknown_arguments_paths_urls_or_write_methods(self):
        bundle = fixture_bundle()
        for params in [{"name": "list_resources", "arguments": {"spaceId": "other"}}, {"name": "read_resource", "arguments": {"resourceId": "../../etc/passwd", "version": 1}},
                       {"name": "read_resource", "arguments": {"resourceId": bundle["resources"][0]["resourceId"], "version": 1, "path": "/etc/passwd"}},
                       {"name": "write_resource", "arguments": {}}, {"name": "read_resource", "arguments": {"url": "file:///etc/passwd"}},
                       {"name": "read_resource", "arguments": {"resourceId": bundle["resources"][0]["resourceId"], "version": True}}]:
            with self.subTest(params=params), self.assertRaises(mcp.RpcError):
                mcp.dispatch(bundle, "tools/call", params)
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "resources/write", {})

    def test_new_version_and_removal_are_exact(self):
        bundle = fixture_bundle()
        identity = bundle["resources"][0]["resourceId"]
        bundle["resources"][0]["version"] = 2
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": identity, "version": 1}})
        self.assertEqual(mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": identity, "version": 2}})["structuredContent"]["data"]["version"], 2)
        bundle["resources"] = []
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": identity, "version": 2}})
        self.assertEqual(mcp.dispatch(bundle, "tools/call", {"name": "list_resources"})["structuredContent"]["data"]["resources"], [])

    def test_bundle_scope_and_boundary_validation(self):
        mutations = [lambda b: b.update(sessionId="other"), lambda b: b.update(conversationId="conv-personal-default"), lambda b: b.update(path="/tmp"),
                     lambda b: b["resources"][0].update(spaceId="other"), lambda b: b["resources"][0].update(text="tampered"),
                     lambda b: b["resources"][0].update(text="x" * 65537), lambda b: b["resources"][0].update(version=True),
                     lambda b: b["resources"].append(copy.deepcopy(b["resources"][0])), lambda b: b["resources"][0].update(resourceId="../../etc/passwd")]
        for mutate in mutations:
            bundle = fixture_bundle()
            mutate(bundle)
            with self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
        personal = fixture_bundle()
        personal.update(conversationId="conv-personal-default", sessionId="conv-personal-default", workspaceId=None, catalogRevision=0, resources=[])
        mcp.validate_bundle(personal)
        self.assertEqual(mcp.dispatch(personal, "tools/call", {"name": "list_resources"})["structuredContent"]["data"]["resources"], [])

    def test_guest_exact_list_and_read_preserves_capture_provenance(self):
        bundle = guest_fixture_bundle()
        mcp.validate_bundle(bundle)
        record = bundle["resources"][0]
        listed = mcp.dispatch(bundle, "tools/call", {"name": "list_resources"})["structuredContent"]["data"]["resources"][0]
        self.assertEqual(listed["resourceId"], record["resourceId"])
        self.assertEqual(listed["contentSha256"], record["contentSha256"])
        self.assertNotIn("text", listed)
        read = mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": listed["resourceId"], "version": listed["version"]}})["structuredContent"]
        self.assertTrue(read["untrusted"])
        self.assertEqual(read["data"], record)
        self.assertEqual(hashlib.sha256(read["data"]["text"].encode()).hexdigest(), record["contentSha256"])
        with self.assertRaises(mcp.RpcError):
            mcp.dispatch(bundle, "tools/call", {"name": "read_resource", "arguments": {"resourceId": listed["resourceId"], "version": 2}})

    def test_guest_provenance_requires_exact_variant_and_bounded_identity(self):
        mutations = [lambda r: r.update(sourceKind="wire-bytes"), lambda r: r.update(captureId="../capture"),
                     lambda r: r.update(screenshotSha256="invalid"), lambda r: r.update(path="/tmp/forged"),
                     lambda r: r.update(extractionVersion="html-text-v1"), lambda r: r.update(page=fixture_bundle()["resources"][0]["evidence"]["snapshot"]["page"]),
                     lambda r: r["page"].update(webContentsId=1), lambda r: r["page"].update(partition="forged-host"),
                     lambda r: r["page"].update(kind="electron"), lambda r: r["page"].update(sandboxName="../sandbox"),
                     lambda r: r["page"].update(browserInstanceId="not-a-uuid"), lambda r: r["page"].update(targetId=""),
                     lambda r: r["page"].update(targetId="x" * 129), lambda r: r["page"].update(navigationEpoch=-1),
                     lambda r: r["page"].update(navigationEpoch=True), lambda r: r["page"].update(navigationEpoch=1.5),
                     lambda r: r["page"].update(navigationEpoch=9007199254740992),
                     lambda r: r["page"].update(url="https://example.com/other"), lambda r: r["page"].update(title="Different title"),
                     lambda r: r.update(title="x" * 4097), lambda r: r.update(title="\U0001f600" * 2049),
                     lambda r: r.update(requestedUrl="file:///etc/passwd"), lambda r: r.update(requestedUrl="https://example.com:8443/"),
                     lambda r: r.update(requestedUrl="https://user:secret@example.com/"), lambda r: r.update(requestedUrl=" https://example.com/"),
                     lambda r: r.update(requestedUrl="https://example.com/\\other"), lambda r: r.update(requestedUrl="https://example.com/\n"),
                     lambda r: r.update(capturedAt="not-a-time"), lambda r: r.update(capturedAt="2026-02-31T12:00:00.000Z"),
                     lambda r: r.update(text="tampered")]
        for index, mutate in enumerate(mutations):
            bundle = guest_fixture_bundle()
            mutate(bundle["resources"][0]["evidence"]["snapshot"])
            with self.subTest(index=index), self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
        for key in ("captureId", "screenshotSha256", "sourceKind"):
            bundle = guest_fixture_bundle()
            del bundle["resources"][0]["evidence"]["snapshot"][key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
            bundle = fixture_bundle()
            bundle["resources"][0]["evidence"]["snapshot"][key] = guest_fixture_bundle()["resources"][0]["evidence"]["snapshot"][key]
            with self.subTest(legacy_extra=key), self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)

    @unittest.skipUnless(sys.platform == "linux", "Linux sealed memfd integration is separately run in the real sandbox")
    def test_sealed_memfd_and_real_stdio_client(self):
        bundle = fixture_bundle()
        fd = mcp.sealed_bundle(bundle)
        try:
            for operation in [lambda: os.write(fd, b"x"), lambda: os.ftruncate(fd, 0), lambda: os.ftruncate(fd, 1048576)]:
                with self.assertRaises(OSError) as caught:
                    operation()
                self.assertEqual(caught.exception.errno, errno.EPERM)
            descriptor = "/proc/%d/fd/%d" % (os.getpid(), fd)
            self.assertEqual(mcp.load_sealed(descriptor), bundle)
            with self.assertRaises(ValueError):
                mcp.load_sealed("/etc/passwd")
            requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "wsl-test", "version": "1"}}},
                        {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": {"progressToken": "fixture-42"}}},
                        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_resources", "arguments": {}}},
                        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read_resource", "arguments": {"resourceId": bundle["resources"][0]["resourceId"], "version": 1}}},
                        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "read_resource", "arguments": {"resourceId": "../../etc/passwd", "version": 1}}}]
            child = subprocess.run([sys.executable, "-I", "-u", "-c", mcp_source, descriptor], input="\n".join(json.dumps(request) for request in requests) + "\n", capture_output=True, text=True, timeout=10)
            self.assertEqual(child.returncode, 0, child.stderr)
            responses = [json.loads(line) for line in child.stdout.splitlines()]
            self.assertEqual(len(responses), 5)
            self.assertEqual(responses[3]["result"]["structuredContent"]["data"]["text"], bundle["resources"][0]["text"])
            self.assertIn("error", responses[4])
        finally:
            os.close(fd)


class MotaResourceMcpTests(unittest.TestCase):
    def setUp(self):
        self.transport = (mcp.OBSERVATION_SOCKET, mcp.OBSERVATION_IMAGES, mcp.MOTA_MODE)
        mcp.configure_transport(['/nonexistent-mota.sock', 'mota'])

    def tearDown(self):
        mcp.OBSERVATION_SOCKET, mcp.OBSERVATION_IMAGES, mcp.MOTA_MODE = self.transport

    def test_mota_lists_only_four_tools_and_immutable_resources_with_own_rules(self):
        tools = mcp.dispatch(fixture_bundle(), 'tools/list', {})['tools']
        self.assertEqual([tool['name'] for tool in tools], [
            'list_resources', 'read_resource', 'app_mota_state', 'app_mota_act', 'app_mota_map_read', 'app_mota_map_set'])
        for tool in tools[2:]:
            self.assertFalse(tool['inputSchema']['additionalProperties'])
            self.assertIn('untrusted observations', tool['description'])
            self.assertIn('real mouse/key input', tool['description'])
            self.assertIn('empty (0) MT1 cell', tool['description'])
            self.assertNotIn('npm', tool['description'])
            self.assertNotIn('app_restart', tool['description'])
        self.assertEqual([tool['annotations']['readOnlyHint'] for tool in tools[2:]], [True, False, True, False])
        initialized = mcp.dispatch({}, 'initialize', {})
        self.assertEqual(initialized['instructions'], mcp.MOTA_RULES)
        listed = mcp.dispatch(fixture_bundle(), 'tools/call', {'name': 'list_resources'})['structuredContent']
        self.assertTrue(listed['untrusted'])
        record = listed['data']['resources'][0]
        read = mcp.dispatch(fixture_bundle(), 'tools/call', {'name': 'read_resource', 'arguments': {
            'resourceId': record['resourceId'], 'version': record['version']}})['structuredContent']
        self.assertEqual(read['data']['text'], fixture_bundle()['resources'][0]['text'])

    def test_launch_mode_is_explicit_and_unknown_modes_do_not_fall_back(self):
        for args in [['/socket', 'Mota'], ['/socket', 'mota', 'text'], ['relative.sock', 'mota'], ['/socket', '']]:
            before = (mcp.OBSERVATION_SOCKET, mcp.OBSERVATION_IMAGES, mcp.MOTA_MODE)
            with self.subTest(args=args), self.assertRaises(ValueError):
                mcp.configure_transport(args)
            self.assertEqual((mcp.OBSERVATION_SOCKET, mcp.OBSERVATION_IMAGES, mcp.MOTA_MODE), before)
        for mode in ('text', 'images'):
            mcp.configure_transport(['/socket', mode])
            self.assertFalse(mcp.MOTA_MODE)
            self.assertEqual(mcp.OBSERVATION_IMAGES, mode == 'images')
            # Untrusted request metadata cannot activate the Mota capability.
            tools = mcp.dispatch({}, 'tools/list', {'_meta': {'mode': 'mota'}})['tools']
            self.assertEqual(tools, mcp.TOOLS + mcp.OBSERVATION_TOOLS + mcp.APP_TOOLS)
            with self.assertRaises(mcp.RpcError) as caught:
                mcp.dispatch({}, 'tools/call', {'name': 'app_mota_state'})
            self.assertEqual(caught.exception.code, -32601)
        mcp.configure_transport([])
        self.assertEqual(mcp.dispatch({}, 'tools/list', {})['tools'], mcp.TOOLS)

    def test_wrong_mode_and_unknown_tools_never_reach_any_transport(self):
        with mock.patch.object(mcp, 'socket_call') as native, mock.patch.object(mcp, 'observe') as observe, \
                mock.patch.object(mcp, 'cli_channel_call') as cli:
            for name in list(mcp.APP_BY_MCP) + [name.replace('.', '_') for name in mcp.OBSERVATION_NAMES] + [
                    'app_mota_execute', 'app_mota_map_delete', 'app.mota.state', 'shell']:
                with self.subTest(name=name), self.assertRaises(mcp.RpcError) as caught:
                    mcp.dispatch({}, 'tools/call', {'name': name, 'arguments': {}})
                self.assertEqual(caught.exception.code, -32601)
            for name in (None, [], {}):
                with self.subTest(name=name), self.assertRaises(mcp.RpcError) as caught:
                    mcp.dispatch({}, 'tools/call', {'name': name})
                self.assertEqual(caught.exception.code, -32602)
            native.assert_not_called()
            observe.assert_not_called()
            cli.assert_not_called()

    def test_illegal_fields_types_and_values_are_rejected_before_socket_dispatch(self):
        page = {'appInstanceId': 'app-1', 'documentGeneration': 3}
        cell = {'appInstanceId': 'app-1', 'expectedSha256': 'a' * 64, 'x': 0, 'y': 1}
        bad = [('app_mota_state', {'runId': 'other'}), ('app_mota_state', []),
               ('app_mota_map_read', {}), ('app_mota_map_read', {'appInstanceId': ''}),
               ('app_mota_map_read', {'appInstanceId': '\U0001f600' * 201}),
               ('app_mota_map_read', {'appInstanceId': 'app-1', 'path': 'project/data.js'}),
               ('app_mota_map_set', {**cell, 'expectedSha256': 'A' * 64}),
               ('app_mota_map_set', {**cell, 'x': True}), ('app_mota_map_set', {**cell, 'y': 64}),
               ('app_mota_map_set', {**cell, 'x': 0.5}), ('app_mota_map_set', {**cell, 'y': float('nan')}),
               ('app_mota_map_set', {**cell, 'value': 999}), ('app_mota_map_set', {**cell, 'floorId': 'MT2'}),
               ('app_mota_map_set', {**cell, 'operationId': 'model-supplied'}),
               ('app_mota_act', {**page, 'documentGeneration': True, 'action': {'type': 'continue'}}),
               ('app_mota_act', {**page, 'documentGeneration': 9007199254740992, 'action': {'type': 'continue'}}),
               ('app_mota_act', {**page, 'resourceId': 'editor', 'action': {'type': 'continue'}})]
        for action in [{'type': 'tile', 'floorId': '../MT1', 'x': 1, 'y': 2},
                       {'type': 'tile', 'floorId': 'MT1', 'x': -1, 'y': 2},
                       {'type': 'tile', 'floorId': 'MT1', 'x': 1, 'y': 2, 'pixelX': 50},
                       {'type': 'continue', 'script': 'core.status.hero.hp = 9999'},
                       {'type': 'newGame', 'hp': 9999}, {'type': 'key', 'key': 'X'},
                       {'type': 'key', 'key': []}, {'type': 'script', 'expression': 'core.status'}, None]:
            bad.append(('app_mota_act', {**page, 'action': action}))
        with mock.patch.object(mcp, 'socket_call') as native:
            for name, args in bad:
                with self.subTest(name=name, args=args), self.assertRaises(mcp.RpcError) as caught:
                    mcp.dispatch({}, 'tools/call', {'name': name, 'arguments': args})
                self.assertEqual(caught.exception.code, -32602)
            native.assert_not_called()

    def test_native_socket_dispatches_exact_four_frames_and_marks_untrusted_failures(self):
        with tempfile.TemporaryDirectory(prefix='wsl-mota-mcp-') as directory:
            path = os.path.join(directory, 'read.sock')
            frames, errors = [], []
            replies = [{'ok': True, 'tool': name, 'data': {'marker': index}} for index, name in enumerate(mcp.MOTA_BY_MCP.values())]
            replies[-1] = {'ok': False, 'tool': 'app.mota.map.set', 'error': {'code': 'stale_source', 'message': 'reread required'}}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(path)
                server.listen(4)
                server.settimeout(3)
                def receive():
                    try:
                        for reply in replies:
                            client, _ = server.accept()
                            with client, client.makefile('rb') as stream:
                                frames.append(json.loads(stream.readline(16385)))
                                client.sendall((json.dumps(reply) + '\n').encode())
                    except Exception as error:
                        errors.append(error)
                worker = threading.Thread(target=receive)
                worker.start()
                try:
                    mcp.configure_transport([path, 'mota'])
                    args = [{}, {'appInstanceId': 'app-1', 'documentGeneration': 3, 'action': {'type': 'tile', 'floorId': 'MT1', 'x': 2, 'y': 3}},
                            {'appInstanceId': 'app-1'}, {'appInstanceId': 'app-1', 'expectedSha256': 'a' * 64, 'x': 2, 'y': 3}]
                    for index, name in enumerate(mcp.MOTA_BY_MCP):
                        result = mcp.dispatch({}, 'tools/call', {'name': name, 'arguments': args[index]})
                        self.assertTrue(result['structuredContent']['untrusted'])
                        self.assertEqual(json.loads(result['content'][0]['text']), result['structuredContent'])
                        self.assertEqual(result['structuredContent']['data'], replies[index])
                        self.assertEqual(result['isError'], index == 3)
                finally:
                    worker.join(4)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(frames, [{'tool': name, 'args': arg} for name, arg in zip(mcp.MOTA_BY_MCP.values(), args)])

    def test_native_failure_never_uses_cli_even_when_channel_environment_exists(self):
        with mock.patch.dict(os.environ, {'WSL_APP_CHANNEL': '/should-not-open'}), \
                mock.patch.object(mcp, 'socket_call', side_effect=OSError('disconnected')) as native, \
                mock.patch.object(mcp, 'cli_channel_call') as cli:
            with self.assertRaises(mcp.RpcError) as caught:
                mcp.dispatch({}, 'tools/call', {'name': 'app_mota_state'})
            self.assertEqual(caught.exception.code, -32603)
            self.assertIn('not replayed', str(caught.exception))
            native.assert_called_once_with(mcp.OBSERVATION_SOCKET, 'app.mota.state', {}, 60)
            for argv in ([], ['help'], ['describe'], ['app.mota.state', '{}']):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(mcp.cli_main(argv), 2)
                self.assertEqual(json.loads(output.getvalue())['error']['code'], 'invalid_request')
            cli.assert_not_called()


class ResearchResourceMcpTests(unittest.TestCase):
    def tearDown(self):
        mcp.configure_transport([])

    def test_tools_require_explicit_research_mode(self):
        for mode in ('text', 'images', 'mota', 'research'):
            mcp.configure_transport(['/tmp/research-fixture.sock', mode])
            names = [tool['name'] for tool in mcp.dispatch({}, 'tools/list', {})['tools']]
            self.assertEqual('research_open' in names, mode == 'research')
            self.assertEqual('research_include' in names, mode == 'research')
            if mode != 'research':
                with self.assertRaises(mcp.RpcError):
                    mcp.dispatch({}, 'tools/call', {'name': 'research_open', 'arguments': {'url': 'https://example.com/'}})

    def test_exact_args_and_no_identity_or_body_injection(self):
        mcp.configure_transport(['/tmp/research-fixture.sock', 'research'])
        invalid = [('research_open', {'url': 'file:///tmp/source'}),
                   ('research_open', {'url': 'https://user:pass@example.com/'}),
                   ('research_open', {'url': 'https://example.com/', 'runId': 'foreign'}),
                   ('research_include', {'captureId': 'not-uuid', 'contentSha256': 'a'*64}),
                   ('research_include', {'captureId': '00000000-0000-0000-0000-000000000000', 'contentSha256': 'a'*64, 'text': 'forged'})]
        with mock.patch.object(mcp, 'socket_call') as channel:
            for name, args in invalid:
                with self.assertRaises(mcp.RpcError):
                    mcp.dispatch({}, 'tools/call', {'name': name, 'arguments': args})
            channel.assert_not_called()

    def test_native_results_preserve_business_failure_and_never_use_cli(self):
        mcp.configure_transport(['/tmp/research-fixture.sock', 'research'])
        args = {'url': 'https://example.com/'}
        denied = {'ok': False, 'tool': 'research.open', 'error': {'code': 'blocked', 'message': 'HTTP 403'}}
        with mock.patch.object(mcp, 'socket_call', return_value=denied) as native, mock.patch.object(mcp, 'cli_channel_call') as cli:
            result = mcp.dispatch({}, 'tools/call', {'name': 'research_open', 'arguments': args})
            self.assertTrue(result['isError'])
            self.assertEqual(result['structuredContent'], {'untrusted': True, 'data': denied})
            native.assert_called_once_with('/tmp/research-fixture.sock', 'research.open', args, 60)
            native.side_effect = OSError('closed')
            with self.assertRaises(mcp.RpcError):
                mcp.dispatch({}, 'tools/call', {'name': 'research_open', 'arguments': args})
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mcp.cli_main(['research.open', json.dumps(args)]), 2)
            cli.assert_not_called()


suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(case) for case in (ResourceMcpTests, MotaResourceMcpTests, ResearchResourceMcpTests))
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
