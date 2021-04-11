import {IListenerInfo, IRawNetPacket, Logger, OPCode, Provider, RPCError, RPCErrorCode, Runtime, Sender, SenderState} from '@sora-soft/framework';
import {io, Socket} from 'socket.io-client';

class WebSocketSender extends Sender {
  static register() {
    Provider.registerSender('ws', (listenerId, targetId) => {
      return new WebSocketSender(listenerId, targetId);
    });
  }

  constructor(listenerId: string, targetId: string, socket?: Socket, endpoint?: string) {
    super(listenerId, targetId);
    if (socket) {
      this.socket_ = socket;
      this.bindSocketEvent();
      this.lifeCycle_.setState(SenderState.READY);
      this.listenInfo_ = {
        id: listenerId,
        protocol: 'ws',
        endpoint,
        labels: {},
      };
    }
  }

  async connect(listenInfo: IListenerInfo) {
    const url = new URL(listenInfo.endpoint);
    this.socket_ = io(url.origin, {
      path: url.pathname
    });

    this.bindSocketEvent();
    this.socket_.connect();
    Runtime.frameLogger.info('sender', {event: 'websocket-sender-connect', endpoint: listenInfo.endpoint});
  }

  async disconnect() {
    // 由客户端主动断开tcp连接
    if (this.socket_)
      this.socket_.disconnect();
    this.socket_ = null;
  }

  async send(request: IRawNetPacket) {
    if (!this.isAvailable())
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.listenInfo_.endpoint}`);
    this.socket_.send(request);
  }

  bindSocketEvent() {
    this.socket_.on('message', (packet: IRawNetPacket) => {
      switch (packet.opcode) {
        case OPCode.RESPONSE:
          this.emitRPCResponse(packet);
          break;
        case OPCode.NOTIFY:
          if (this.route_) {
            this.routeCallback_(packet, this.session_).catch(err => {
              Runtime.frameLogger.error('sender.websocket', err, { event: 'sender-notify-handler', error: Logger.errorMessage(err) });
            });
          }
        case OPCode.REQUEST:
          // 这里不应该接收到请求
          break;
      }
    });
    this.socket_.on('reconnect_attempt', (attempt: number) => {
      Runtime.frameLogger.info('sender.websocket', { event: 'sender-reconnect-attempt', attempt, });
    });
    this.socket_.on('reconnect', () => {
      Runtime.frameLogger.success('sender.websocket', { event: 'sender-reconnect-success' });
    });
  }

  isAvailable() {
    return this.socket_ && this.socket_.connected;
  }

  private socket_: Socket;
}

export {WebSocketSender}
