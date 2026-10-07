"""Standard-library tests. Caller supplies the real module as mcp; no model calls."""
import copy
import errno
import hashlib
import io
import json
import os
import subprocess
import sys
import unittest


def fixture_bundle():
    body = "Example Domain\nThis domain is for use in illustrative examples in documents."
    return {"conversationId": "conv-space-taskflow-demo-impl", "generation": "generation-1", "turnId": "turn-1", "spaceId": "taskflow-demo", "collectionRevision": 1,
            "resources": [{"resourceId": "e6b3d0b2-891e-4f7b-a49b-5990aef2b911", "version": 1, "spaceId": "taskflow-demo", "page": {"webContentsId": 2, "documentGeneration": 3, "url": "https://example.com/", "title": "Example Domain", "partition": "persist:wsl-preview"},
                           "requestedUrl": "https://example.com/", "url": "https://example.com/", "title": "Example Domain", "text": body, "capturedAt": "2026-10-06T12:00:00.000Z", "sourceSha256": "a" * 64,
                           "contentSha256": hashlib.sha256(body.encode()).hexdigest(), "extractionVersion": "html-text-v1", "truncated": False}]}


def guest_fixture_bundle():
    bundle = fixture_bundle()
    record = bundle["resources"][0]
    record.update(extractionVersion="rendered-dom-text-v1", sourceKind="decoded-main-response",
                  captureId="9106578b-e2ce-4c19-a8b7-06753245eaa5", screenshotSha256="c" * 64)
    record["page"] = {"kind": "sandbox-chromium", "sandboxName": "wsl-sbx-smoke-20261006",
                      "browserInstanceId": "5cd9a82c-d94e-4774-854d-e58083e49e9b", "targetId": "CDP-TARGET-1", "navigationEpoch": 1,
                      "url": record["url"], "title": record["title"]}
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
        self.assertEqual(mcp.dispatch(bundle, "tools/call", {"name": "list_resources", "arguments": {}, **metadata})["structuredContent"]["data"]["spaceId"], "taskflow-demo")

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
        mutations = [lambda b: b.update(spaceId="other"), lambda b: b.update(conversationId="conv-personal-default"), lambda b: b.update(path="/tmp"),
                     lambda b: b["resources"][0].update(spaceId="other"), lambda b: b["resources"][0].update(text="tampered"),
                     lambda b: b["resources"][0].update(text="x" * 65537), lambda b: b["resources"][0].update(version=True),
                     lambda b: b["resources"].append(copy.deepcopy(b["resources"][0])), lambda b: b["resources"][0].update(resourceId="../../etc/passwd")]
        for mutate in mutations:
            bundle = fixture_bundle()
            mutate(bundle)
            with self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
        personal = fixture_bundle()
        personal.update(conversationId="conv-personal-default", spaceId=None, collectionRevision=0, resources=[])
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
                     lambda r: r.update(extractionVersion="html-text-v1"), lambda r: r.update(page=fixture_bundle()["resources"][0]["page"]),
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
            mutate(bundle["resources"][0])
            with self.subTest(index=index), self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
        for key in ("captureId", "screenshotSha256", "sourceKind"):
            bundle = guest_fixture_bundle()
            del bundle["resources"][0][key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                mcp.validate_bundle(bundle)
            bundle = fixture_bundle()
            bundle["resources"][0][key] = guest_fixture_bundle()["resources"][0][key]
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


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ResourceMcpTests))
if not result.wasSuccessful():
    raise SystemExit(1)
