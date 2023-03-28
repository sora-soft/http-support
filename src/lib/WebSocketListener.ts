import {ExError, ILabels, Listener, ListenerCallback, ListenerState, Logger, Runtime, Time, Utility} from '@sora-soft/framework';
import {v4 as uuid} from 'uuid';
import http from 'http';
import util from 'util';
import {WebSocketServer} from 'ws';
import {EventEmitter} from 'events';
import {readFile} from 'fs/promises';
import {WebSocketConnector} from './WebSocketConnector.js';
import {HTTPError} from './HTTPError.js';
import {HTTPErrorCode} from './HTTPErrorCode.js';
import {TypeGuard} from '@sora-soft/type-guard';

const pkg = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), {encoding: 'utf-8'})
) as {version: string};

export interface IWebSocketListenerOptions {
  portRange?: number[];
  port?: number;
  host: string;
  entryPath: string;
  labels?: ILabels;
  exposeHost?: string;
}

class WebSocketListener extends Listener {
  constructor(options: IWebSocketListenerOptions, callback: ListenerCallback, labels: ILabels = {}) {
    super(callback, labels);

    TypeGuard.assert<IWebSocketListenerOptions>(options);
    this.options_ = options;
    this.httpServer_ = http.createServer();
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
    };
  }

  getSocket(session: string) {
    return this.socketMap_.get(session);
  }

  protected async listen() {
    if (this.options_.portRange)
      await this.listenRange(this.options_.portRange[0], this.options_.portRange[1]);

    if (this.options_.port) {
      this.usePort_ = this.options_.port;
      await util.promisify<number, string, void>(this.httpServer_.listen.bind(this.httpServer_) as (port: number, host: string) => void)(this.usePort_, this.options_.host);
    }

    this.socketServer_ = new WebSocketServer({server: this.httpServer_, path: this.options_.entryPath});
    this.socketServer_.on('connection', (socket, request) => {
      if (this.state !== ListenerState.READY) {
        socket.close();
        return;
      }

      const session = uuid();
      const connector = new WebSocketConnector(socket, request.socket.remoteAddress);
      this.newConnector(session, connector);
    });

    this.socketServer_.on('error', (err: ExError) => {
      this.onServerError(err);
    });

    return this.metaData;
  }

  protected async shutdown() {
    // 要等所有 socket 由对方关闭
    if (this.socketServer_)
      await util.promisify(this.socketServer_.close.bind(this.socketServer_) as () => void)();
    this.socketServer_ = null;
  }

  private onServerError(err: Error) {
    this.lifeCycle_.setState(ListenerState.ERROR, err).catch(Utility.null);
    Runtime.frameLogger.error('listener.web-socket', err, {event: 'web-socket-server-on-error', error: Logger.errorMessage(err)});
  }

  protected listenRange(min: number, max: number) {
    this.usePort_  = min;
    return new Promise<void>((resolve, reject) => {
      const onError = async (err: ExError) => {
        if (err.code === 'EADDRINUSE') {
          this.usePort_ = this.usePort_ + Utility.randomInt(0, 5);
          if (this.usePort_ > max) {
            reject(new HTTPError(HTTPErrorCode.ERR_NO_AVAILABLE_PORT, 'ERR_NO_AVAILABLE_PORT'));
            return;
          }
          await Time.timeout(100);

          this.httpServer_.listen(this.usePort_, this.options_.host);
        } else {
          throw err;
        }
      };

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
  private socketServer_: WebSocketServer | null;
  private socketMap_: Map<string, WebSocket>;
  private usePort_: number;
}

export {WebSocketListener};
