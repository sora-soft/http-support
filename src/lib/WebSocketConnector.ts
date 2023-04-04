import {Connector, AbortError, ConnectorState, IConnectorPingOptions, IListenerInfo, IRawNetPacket, Logger, NodeTime, Retry, RetryEvent, RPCError, RPCErrorCode, RPCSender, Runtime, Utility, ExError} from '@sora-soft/framework';
import {Context} from '@sora-soft/framework';
import WebSocket from 'ws';
import util from 'util';
import {TypeGuard} from '@sora-soft/type-guard';

const PROTOCOL = 'ws';

class WebSocketConnector extends Connector {
  static register() {
    Runtime.pvdManager.registerSender(PROTOCOL, (listenerId, targetId, weight) => {
      return new RPCSender(listenerId, targetId, new WebSocketConnector(), weight);
    });
  }

  constructor(socket?: WebSocket, endpoint?: string) {
    super({ping: {enabled: true}});
    this.socket_ = null;
    if (socket && endpoint) {
      this.socket_ = socket;
      this.bindSocketEvent(this.socket_);
      this.lifeCycle_.setState(ConnectorState.READY).catch(Utility.null);
      this.target_ = {
        protocol: PROTOCOL,
        endpoint,
        labels: {},
      };
    }
  }

  get pingOptions(): IConnectorPingOptions {
    return {
      enabled: true,
      timeout: NodeTime.second(5),
    };
  }

  protected async connect(listenInfo: IListenerInfo, context: Context) {
    if (this.isAvailable())
      return;

    const retry = new Retry(async (ctx) => {
      return new Promise<void>((resolve, reject) => {
        Runtime.frameLogger.info('connector.websocket', {event: 'connector-connect', endpoint: listenInfo.endpoint});
        ctx.signal.addEventListener('abort', () => {
          reject(new AbortError());
        });

        this.socket_ = new WebSocket(listenInfo.endpoint);
        const handlerError = (err: Error) => {
          reject(err);
        };
        this.socket_.once('error', handlerError);
        this.bindSocketEvent(this.socket_);

        this.socket_.on('open', () => {
          if (this.socket_) {
            this.socket_.removeListener('error', handlerError);
          }
          Runtime.frameLogger.success('connector.websocket', {event: 'connect-success', endpoint: listenInfo.endpoint});
          resolve();
        });
      });
    }, {
      maxRetryTimes: 0,
      incrementInterval: true,
      maxRetryIntervalMS: 5000,
      minIntervalMS: 500,
    });

    retry.errorEmitter.on(RetryEvent.Error, (err, nextRetry) => {
      Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-on-error', error: Logger.errorMessage(err), nextRetry});
    });

    await retry.doJob(context);
  }

  protected async disconnect() {
    if (this.socket_) {
      this.socket_.removeAllListeners();
      this.socket_.close();
    }
    this.socket_ = null;
  }

  async sendRaw(packet: Object): Promise<void> {
    if (!this.isAvailable())
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.target_?.endpoint || 'unknown'}`);

    if (!this.socket_)
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.target_?.endpoint || 'unknown'}`);

    await util.promisify<string, void>(this.socket_.send.bind(this.socket_) as (buf: string) => void)(JSON.stringify(packet)).catch((err: Error) => {
      throw new RPCError(RPCErrorCode.ERR_RPC_SENDER_INNER, `ERR_RPC_SENDER_INNER, err=${err.message}`);
    });
  }

  async send(packet: IRawNetPacket) {
    return this.sendRaw(packet);
  }

  private onSocketError(socket: WebSocket) {
    return (err: ExError) => {
      if (this.socket_ !== socket)
        return;

      if (this.socket_) {
        this.socket_.removeAllListeners();
      }

      this.socket_ = null;
      this.off().catch((offError: ExError) => {
        Runtime.rpcLogger.error('connector.websocket', offError, {event: 'connect-off-error', error: Logger.errorMessage(offError), reason: err.message});
      });
      return;
    };
  }

  private bindSocketEvent(socket: WebSocket) {
    socket.on('error', this.onSocketError(socket));
    socket.on('close', this.onSocketError(socket));
    socket.on('message', (payload: Buffer) => {
      let packet: IRawNetPacket | null = null;
      try {
        packet = JSON.parse(payload.toString()) as IRawNetPacket;
      } catch (e) {
        const err = ExError.fromError(e as Error);
        Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-decode-message', error: Logger.errorMessage(err)});
      }

      if (!packet)
        return;

      if (!TypeGuard.is<IRawNetPacket>(packet)) {
        const err = new RPCError(RPCErrorCode.ERR_RPC_BODY_PARSE_FAILED, 'ERR_RPC_BODY_PARSE_FAILED');
        Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-body-invalid', packet});
        return;
      }

      this.handleIncomeMessage(packet, this.session, this).catch((err: ExError) => {
        Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-handle-income-message-error', error: Logger.errorMessage(err)});
      });
    });
  }

  isAvailable() {
    return !!(this.socket_ && this.socket_.readyState === WebSocket.OPEN);
  }

  private socket_: WebSocket | null;
}

export {WebSocketConnector};
