import {Connector, ConnectorCommand, ConnectorState, IConnectorPingOptions, IListenerInfo, IRawNetPacket, IRawResPacket, Logger, NodeTime, OPCode, Provider, Retry, RetryEvent, RPCError, RPCErrorCode, RPCSender, Runtime} from '@sora-soft/framework';
import {is} from 'typescript-is';
import * as WebSocket from 'ws';

const PROTOCOL = 'ws';

class WebSocketConnector extends Connector {
  static register() {
    Provider.registerSender(PROTOCOL, (listenerId, targetId) => {
      return new RPCSender(listenerId, targetId, new WebSocketConnector());
    });
  }

  constructor(socket?: WebSocket, endpoint?: string) {
    super({ping: {enabled: true}});
    if (socket && endpoint) {
      this.initiative_ = false;
      this.socket_ = socket;
      this.bindSocketEvent(this.socket_);
      this.lifeCycle_.setState(ConnectorState.READY);
      this.target_ = {
        protocol: PROTOCOL,
        endpoint,
        labels: {},
      };
    } else {
      this.initiative_ = true;
    }
  }

  get pingOptions(): IConnectorPingOptions {
    return {
      enabled: true,
      timeout: NodeTime.second(5),
    };
  }

  protected async connect(listenInfo: IListenerInfo, reconnect = false) {
    if (this.isAvailable())
      return;

    if (!this.initiative_) {
      this.off();
      return;
    }

    const retry = new Retry(async () => {
      return new Promise<void>((resolve, reject) => {
        Runtime.frameLogger.info('connector.websocket', {event: reconnect ? 'connector-reconnect' : 'connector-connect', endpoint: listenInfo.endpoint});
        this.socket_ = new WebSocket(listenInfo.endpoint);
        const handlerError = (err: Error) => {
          reject(err)
        }
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

    this.reconnectJob_ = retry;
    await retry.doJob();
    this.reconnectJob_ = null;
  }

   protected async disconnect() {
    if (this.reconnectJob_) {
      this.reconnectJob_.cancel();
    }
    if (this.socket_) {
      this.socket_.removeAllListeners();
      this.socket_.close();
    }
    this.socket_ = null;
  }

  protected async sendRaw(packet: Object): Promise<void> {
    if (!this.isAvailable())
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.target_.endpoint}`);

    this.socket_!.send(JSON.stringify(packet));
  }

  protected async send(packet: IRawNetPacket) {
    if (!this.isAvailable())
      throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.target_.endpoint}`);

    this.socket_!.send(JSON.stringify(packet));
  }

  private async reconnect_() {
    await this.connect(this.target_, true).then(() => {
      this.lifeCycle_.setState(ConnectorState.READY);
    }).catch((err: Error) => {
      this.lifeCycle_.setState(ConnectorState.ERROR, err);
    });
  }

  private onSocketError(socket: WebSocket) {
    return (err: Error) => {
      if (this.socket_ !== socket)
        return;

      if (this.socket_) {
        this.socket_.removeAllListeners();

        if (!this.initiative_) {
          this.destory();
          return;
        }
      }

      this.socket_ = null;
      if (this.lifeCycle_.state === ConnectorState.READY) {
        this.lifeCycle_.setState(ConnectorState.RECONNECTING, err);
        this.reconnect_();
      }
      return;
    }
  }

  private bindSocketEvent(socket: WebSocket) {
    socket.on('error', this.onSocketError(socket));
    socket.on('close', this.onSocketError(socket));
    socket.on('message', (payload: Buffer) => {
      let packet: IRawNetPacket | null = null;
      try {
        packet = JSON.parse(payload.toString());
      } catch (err) {
        Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-decode-message', error: Logger.errorMessage(err)});
      }

      if (!packet)
        return;

      if (!is<IRawNetPacket>(packet)) {
        const err = new RPCError(RPCErrorCode.ERR_RPC_BODY_PARSE_FAILED, `ERR_RPC_BODY_PARSE_FAILED`);
        Runtime.frameLogger.error('connector.websocket', err, {event: 'connector-body-invalid', packet});
      }
      this.handleIncomeMessage(packet, this.session, this);
    });
  }

  isAvailable() {
    return !!(this.socket_ && this.socket_.readyState === WebSocket.OPEN);
  }

  private socket_: WebSocket | null;
  private initiative_ = true;
  private reconnectJob_: Retry<void> | null;
}

export {WebSocketConnector}
