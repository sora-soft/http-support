import {Executor, ExError, ILabels, IRawNetPacket, Listener, ListenerCallback, ListenerEvent, ListenerState, Logger, OPCode, Runtime, Time, Utility} from '@sora-soft/framework';
import {v4 as uuid} from 'uuid';
import http = require('http');
import util = require('util');
import * as WebSocket from 'ws';
import {EventEmitter} from 'events';
import {HTTPError, HTTPErrorCode} from '..';

// tslint:disable-next-line
const pkg = require('../../package.json');

export interface IWebSocketListenerOptions {
  portRange?: number[];
  port?: number;
  host: string;
  entryPath: string;
  labels?: ILabels;
  exposeHost?: string;
}

class WebSocketListener extends Listener {
  constructor(options: IWebSocketListenerOptions, callback: ListenerCallback, executor: Executor, httpServer?: http.Server | null, labels: ILabels = {}) {
    super(callback, executor, labels);

    this.options_ = options;
    this.httpServer_ = httpServer || http.createServer();
    this.usePort_ = 0;
    this.socketMap_ = new Map();
    this.connectionEmitter_ = new EventEmitter();
  }

  get exposeHost() {
    return this.options_.exposeHost || this.options_.host;
  }

  get metaData() {
    return {
      id: this.id,
      protocol: 'ws',
      endpoint: `ws://${this.exposeHost}:${this.usePort_}${this.options_.entryPath}`,
      state: this.state,
      labels: this.labels,
    }
  }

  getSocket(session: string) {
    return this.socketMap_.get(session);
  }

  protected async listen() {
    this.socketServer_ = new WebSocket.Server({server: this.httpServer_, path: this.options_.entryPath});

    this.socketServer_.on('connection', (socket, request) => {
      const session = uuid();

      this.socketMap_.set(session, socket);

      socket.on('close', () => {
        this.socketMap_.delete(session);
      });

      socket.on('message', async (buffer) => {
        const str = buffer.toString();
        let packet: IRawNetPacket | null = null;
        try {
          packet = JSON.parse(str);
        } catch (err) {
          Runtime.frameLogger.debug('listener.web-socket', err, { event: 'parse-body-failed', error: Logger.errorMessage(err) });
        }

        if (!packet)
          return;

        await this.handleMessage(async (listenerDataCallback) => {
          try {
            const response = await listenerDataCallback(packet as IRawNetPacket, session);
            if (response) {
              socket.send(JSON.stringify(response));
            }
          } catch (err) {
            Runtime.frameLogger.error('listener.web-socket', err, { event: 'event-handle-rpc', error: Logger.errorMessage(err)});
          }
        });
      });

      this.connectionEmitter_.emit(ListenerEvent.NewConnect, session, socket);
    });

    if (this.options_.portRange)
      await this.listenRange(this.options_.portRange[0], this.options_.portRange[1]);

    if (this.options_.port) {
      this.usePort_ = this.options_.port;

      await util.promisify<number, string, void>(this.httpServer_.listen.bind(this.httpServer_))(this.usePort_, this.options_.host);
    }

    this.httpServer_.on('error', this.onServerError.bind(this));

    return this.metaData;
  }

  protected async shutdown() {
    await util.promisify(this.httpServer_.close.bind(this.httpServer_))();
    this.socketServer_ = null;
  }

  private onServerError(err: Error) {
    this.lifeCycle_.setState(ListenerState.ERROR, err);
    Runtime.frameLogger.error('listener.web-socket', err, {event: 'web-socket-server-on-error', error: Logger.errorMessage(err)});
  }

  protected listenRange(min: number, max: number) {
    return new Promise<void>((resolve, reject) => {
      this.usePort_ = min + Utility.randomInt(0, 5);

      const onError = async (err: ExError) => {
        if (err.code === 'EADDRINUSE') {
          if (this.usePort_ + 5 > max) {
            reject(new HTTPError(HTTPErrorCode.ERR_NO_AVAILABLE_PORT, `ERR_NO_AVAILABLE_PORT`));
          }

          this.usePort_ = this.usePort_ + Utility.randomInt(0, 5);
          await Time.timeout(100);

          this.httpServer_.listen(this.usePort_, this.options_.host);
        } else {
          throw err;
        }
      }

      this.httpServer_.on('error', onError);

      this.httpServer_.once('listening', () => {
        this.httpServer_.removeListener('error', onError);
        resolve();
      });

      this.httpServer_.listen(this.usePort_, this.options_.host);
    });
  }

  get version () {
    return pkg.version;
  }

  private options_: IWebSocketListenerOptions;
  private httpServer_: http.Server;
  private socketServer_: WebSocket.Server | null;
  private socketMap_: Map<string, WebSocket>;
  private usePort_: number;
}

export {WebSocketListener}
