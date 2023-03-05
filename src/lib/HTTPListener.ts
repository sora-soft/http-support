import {ExError, ILabels, Listener, ListenerCallback, ListenerState, Logger, Runtime, Time, Utility} from '@sora-soft/framework';
import http = require('http');
import {HTTPError} from './HTTPError';
import {HTTPErrorCode} from './HTTPErrorCode';
import util = require('util');
import Koa = require('koa');
import {v4 as uuid} from 'uuid';
import {HTTPConnector} from './HTTPConnector';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
const pkg: {version: string} = require('../../package.json');

export interface IHTTPListenerOptions {
  portRange?: number[];
  port?: number;
  host: string;
  labels?: ILabels;
  expose?: string;
}

class HTTPListener extends Listener {
  constructor(options: IHTTPListenerOptions, koa: Koa, callback: ListenerCallback, labels: ILabels = {}) {
    super(callback, labels);

    this.options_ = options;

    this.koa_ = koa;
    this.httpServer_ = http.createServer(this.koa_.callback());
    this.usePort_ = 0;
    this.installKoa();
  }

  get metaData() {
    return {
      id: this.id,
      protocol: 'http',
      endpoint: this.endpoint,
      state: this.state,
      labels: this.labels
    };
  }

  get endpoint() {
    if (this.options_.expose) {
      return `http://${this.options_.expose}:${this.usePort_}`;
    }
    return `http://${this.options_.host}:${this.usePort_}`;
  }

  get version () {
    return pkg.version;
  }

  private installKoa() {
    this.koa_.use(async (ctx, next) => {
      const requestSession = ctx.cookies.get('sora-http-session');
      const session = requestSession || ctx.headers['sora-http-session'] as string || uuid();

      const connector = new HTTPConnector(ctx);
      this.newConnector(session, connector);

      await connector.promise;
      await next();
    });
  }

  protected async listen() {
    if (this.options_.portRange)
      await this.listenRange(this.options_.portRange[0], this.options_.portRange[1]);

    if (this.options_.port) {
      this.usePort_ = this.options_.port;

      await util.promisify<number, string, void>(this.httpServer_.listen.bind(this.httpServer_) as (port: number, host: string) => void)(this.usePort_, this.options_.host);

      this.httpServer_.on('error', (err: ExError) => {
        this.onServerError(err);
      });
    }

    return {
      id: this.id,
      protocol: 'http',
      endpoint: this.endpoint,
      labels: this.labels,
    };
  }

  private onServerError(err: Error) {
    this.lifeCycle_.setState(ListenerState.ERROR, err).catch(Utility.null);
    Runtime.frameLogger.error('listener.http', err, {event: 'http-server-on-error', error: Logger.errorMessage(err)});
  }

  protected listenRange(min: number, max: number) {
    return new Promise<void>((resolve, reject) => {
      this.usePort_ = min + Utility.randomInt(0, 5);

      const onError = async (err: ExError) => {
        if (err.code === 'EADDRINUSE') {
          if (this.usePort_ + 5 > max) {
            reject(new HTTPError(HTTPErrorCode.ERR_NO_AVAILABLE_PORT, 'ERR_NO_AVAILABLE_PORT'));
          }

          this.usePort_ = this.usePort_ + Utility.randomInt(0, 5);
          await Time.timeout(100);

          this.httpServer_.listen(this.usePort_, this.options_.host);
        } else {
          throw err;
        }
      };

      this.httpServer_.on('error', onError);

      this.httpServer_.once('listening', () => {
        this.httpServer_.removeListener('error', onError);

        this.httpServer_.on('error', (err: ExError) => {
          this.onServerError(err);
        });
        resolve();
      });

      this.httpServer_.listen(this.usePort_, this.options_.host);
    });
  }

  protected async shutdown() {
    await util.promisify(this.httpServer_.close.bind(this.httpServer_) as () => void)();
  }

  get httpServer() {
    return this.httpServer_;
  }

  private httpServer_: http.Server;
  private koa_: Koa;
  private options_: IHTTPListenerOptions;
  private usePort_: number;
}

export {HTTPListener};
