import { ChatServiceMessageSchema, ChatServiceRequestSchema, type ChatServiceMessage } from '@wsl/protocol';
import { CodexChat } from './codex-chat';
import { Terminal } from './terminal';
import { ResourceStore } from './resource-store';

// utilityProcess 的消息接口由宿主提供，核心模块不依赖 Electron。
const parent = (
  process as NodeJS.Process & {
    parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
  }
).parentPort;
if (!parent) throw new Error('缺少执行服务父消息通道');
const root = process.argv[2];
if (!root) throw new Error('缺少对话运行目录');
const send = (message: ChatServiceMessage) => parent.postMessage(ChatServiceMessageSchema.parse(message));
const resources = new ResourceStore(root);
const chat = new CodexChat(root, (conversation) => send({ type: 'event', conversation }), undefined, resources);
const terminal = new Terminal(chat.connection, (snapshot) => send({ type: 'terminal-event', terminal: snapshot }));
const ready = chat.initialize().then((status) => {
  send({ type: 'initialized', status, cleanupPending: chat.connection.getCleanupPending() });
  return status;
});
// 对话入口与资源提交共享顺序，防止持久化中插入旧快照轮次；send 不等待模型完成。
let resourceOperations: Promise<unknown> = Promise.resolve();
parent.on('message', ({ data }) => {
  const request = ChatServiceRequestSchema.parse(data);
  const execute = async () => {
    try {
      await ready;
      let result;
      switch (request.method) {
        case 'resources.list':
          result = await resources.list(request.payload.spaceId);
          break;
        case 'resources.save': {
          chat.assertResourceMutationAllowed(request.payload.spaceId);
          const before = await resources.list(request.payload.spaceId);
          result = await resources.save(request.payload.spaceId, request.payload.snapshot, request.payload.resourceId);
          if (result.revision !== before.revision) chat.invalidateResources(request.payload.spaceId);
          break;
        }
        case 'resources.remove':
          chat.assertResourceMutationAllowed(request.payload.spaceId);
          result = await resources.remove(request.payload.spaceId, request.payload.resourceId);
          chat.invalidateResources(request.payload.spaceId);
          break;
        case 'status':
          result = chat.getStatus();
          break;
        case 'get':
          result = chat.get(request.payload.conversationId);
          break;
        case 'send':
          result = await chat.send(request.payload.conversationId, request.payload.text);
          break;
        case 'cancel':
          result = await chat.cancel(request.payload.conversationId);
          break;
        case 'reset':
          result = await chat.reset(request.payload.conversationId);
          break;
        case 'terminal.get':
          result = terminal.get();
          break;
        case 'terminal.open':
          result = await terminal.open(request.payload.cols, request.payload.rows);
          break;
        case 'terminal.write':
          terminal.write(request.payload.sessionId, request.payload.data);
          result = null;
          break;
        case 'terminal.resize':
          terminal.resize(request.payload.sessionId, request.payload.cols, request.payload.rows);
          result = null;
          break;
        case 'terminal.close':
          result = await terminal.close(request.payload.sessionId);
          break;
        case 'shutdown': {
          const results = await Promise.allSettled([chat.shutdown(), terminal.shutdown()]);
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;

          result = null;
          break;
        }
      }
      send({ type: 'response', id: request.id, result });
      // ACK须由宿主收到后再结束utility，立即exit会丢失仍在传输的消息。
    } catch (error) {
      send({ type: 'error', id: request.id, error: (error as Error).message });
    }
  };
  if (['send', 'cancel', 'reset', 'shutdown', 'resources.save', 'resources.remove'].includes(request.method)) {
    resourceOperations = resourceOperations.then(execute);
  } else void execute();
});

process.on('SIGTERM', () => {
  void Promise.all([chat.shutdown(), terminal.shutdown()])
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('guest 清理失败', error);
      process.exitCode = 1;
    });
});
