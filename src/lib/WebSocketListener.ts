import {Executor, ExError, ILabels, IRawNetPacket, Listener, ListenerCallback, ListenerState, Logger, Runtime, Time, Utility} from '@sora-soft/framework';
import http = require('http');
import io = require('socket.io');
import {HTTPError} from './HTTPError';
import {HTTPErrorCode} from './HTTPErrorCode';
import util = require('util');
import cookie = require('cookie');
import {v4 as uuid} from 'uuid';

// tslint:disable-next-line
const pkg = require('../../package.json');

export interface IWebSocketListenerOptions {
  portRange?: number[];
  port?: number;
  host: string;
  entryPath: string;
  labels?: ILabels;
}

class WebSocketListener extends Listener {
  constructor(options: IWebSocketListenerOptions, callback: ListenerCallback, executor: Executor, httpServer?: http.Server, labels: ILabels = {}) {
    super(callback, executor, labels);

    this.options_ = options;
    this.httpServer_ = httpServer || http.createServer();
    this.usePort_ = 0;
  }

  get metaData() {
    return {
      id: this.id,
      protocol: 'ws',
      endpoint: `ws://${this.options_.host}:${this.usePort_}${this.options_.entryPath}`,
      state: this.state,
      labels: this.labels
    }
  }

  protected async listen() {
    this.socketServer_ = new io.Server(this.httpServer_, {
      path: this.options_.entryPath
    });

    this.socketServer_.on('connect', (socket) => {
      const cookies = cookie.parse(socket.request.headers.cookie || '');
      const requestSession = cookies['sora-http-session'];

      const session = requestSession || uuid();

      if (session !== requestSession)
        socket.handshake.headers.cookie = cookie.serialize('sora-http-session', session);

      socket.on('message', async (packet: IRawNetPacket) => {
        await this.handleMessage(async (listenerDataCallback) => {
          try {
            const response = await listenerDataCallback(packet, session);
            if (response) {
              socket.send(response);
            }
          } catch (err) {
            Runtime.frameLogger.error('listener.websocket', err, { event: 'event-handle-rpc', error: Logger.errorMessage(err)});
          }
        });
      });
    })

    if (this.options_.portRange)
      await this.listenRange(this.options_.portRange[0], this.options_.portRange[1]);

    if (this.options_.port) {
      this.usePort_ = this.options_.port;

      await util.promisify<number, string, void>(this.httpServer_.listen.bind(this.httpServer_))(this.usePort_, this.options_.host);
    }

    this.httpServer_.on('error', this.onServerError.bind(this));

    return {
      id: this.id,
      protocol: 'ws',
      endpoint: `ws://${this.options_.host}:${this.usePort_}${this.options_.entryPath}`,
      labels: this.labels,
    }
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
  private socketServer_: io.Server;
  private usePort_: number;
}

export {WebSocketListener}
