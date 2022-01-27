import {IListenerInfo, IRawNetPacket, Logger, OPCode, Provider, RPCError, RPCErrorCode, Runtime, Sender, SenderState} from '@sora-soft/framework';
import * as WebSocket from 'ws';

class WebSocketSender extends Sender {
  static register() {
    Provider.registerSender('ws', (listenerId, targetId) => {
      return new WebSocketSender(listenerId, targetId);
    });
  }

  constructor(listenerId: string, targetId: string, socket?: WebSocket, endpoint?: string)
  constructor(listenerId: string, targetId: string, socket: WebSocket, endpoint: string) {
    super(listenerId, targetId);
    if (socket) {
      this.reconnect_ = false;
      this.socket_ = socket;
      this.bindSocketEvent(this.socket_);
      this.lifeCycle_.setState(SenderState.READY);
      this.listenInfo_ = {
        id: listenerId,
        protocol: 'ws',
        endpoint,
        labels: {},
      };
    } else {
      this.reconnect_ = true;
    }
    this.reconnectAttempt_ = 0;
  }

  async connect(listenInfo: IListenerInfo) {
    const url = new URL(listenInfo.endpoint);
    this.socket_ = new WebSocket(url.origin, {
      path: url.pathname
    });
    this.bindSocketEvent(this.socket_);
    await this.waitUntilOpen(this.socket_);
    Runtime.frameLogger.info('sender', {event: 'websocket-sender-connect', endpoint: listenInfo.endpoint});
  }

  async disconnect() {
    // 由客户端主动断开tcp连接
    if (this.socket_)
      this.socket_.close();
    this.socket_ = null;
  }

  async send(packet: IRawNetPacket) {
    if (!this.isAvailable())
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.listenInfo_.endpoint}`);

    this.socket_!.send(JSON.stringify(packet));
  }

  async waitUntilOpen(socket: WebSocket) {
    return new Promise<void>((resolve) => {
      socket.on('open', () => {
        this.reconnectAttempt_ = 0;
        resolve();
      });
    });
  }

  bindSocketEvent(socket: WebSocket) {
    socket.on('message', (packet: IRawNetPacket) => {
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
    socket.on('close', () => {
      if (!this.reconnect_) {
        this.off();
      } else {
        this.reconnectAttempt_ ++;
        Runtime.frameLogger.info('sender.websocket', { event: 'sender-reconnect-attempt', attempt: this.reconnectAttempt_ });
        this.connect(this.listenInfo_);
      }
    });
  }

  isAvailable() {
    return !!(this.socket_ && this.socket_.readyState === WebSocket.OPEN);
  }

  private socket_: WebSocket | null;
  private reconnect_: boolean;
  private reconnectAttempt_: number;
}

export {WebSocketSender}
