import {Executor, ExError, IListenerInfo, IRawNetPacket, Listener, ListenerCallback, ListenerState, Logger, OPCode, RPCErrorCode, Runtime, Time, Utility} from '@sora-soft/framework';
import http = require('http');
import {HTTPError} from './HTTPError';
import {HTTPErrorCode} from './HTTPErrorCode';
import util = require('util');
import Koa = require('koa');
import path = require('path');
import {v4 as uuid} from 'uuid';

export interface IHTTPListenerOptions {
  portRange?: number[];
  port?: number;
  host: string;
}

class HTTPListener extends Listener {
  constructor(options: IHTTPListenerOptions, koa: Koa, callback: ListenerCallback, executor: Executor) {
    super(callback, executor);

    this.options_ = options;

    this.koa_ = koa;
    this.httpServer_ = http.createServer(this.koa_.callback());
    this.installKoa();
  }

  get metaData() {
    return {
      id: this.id,
      protocol: 'http',
      endpoint: `${this.options_.host}:${this.usePort_}`,
      state: this.state
    }
  }

  private installKoa() {
    this.koa_.use(async (ctx, next) => {
      await this.handleMessage(async (listenerDataCallback) => {
        return new Promise((resolve, reject) => {
          const req = ctx.req;
          let body = '';

          req.on('data', (chunk) => {
            body += chunk;
          });

          const handleReq = async () => {
            let payload: any;

            try {
              payload = JSON.parse(body);
            } catch (err) {
              Runtime.frameLogger.debug('listener.http', err, { event: 'parse-body-failed', error: Logger.errorMessage(err) });
              ctx.body = { error: RPCErrorCode.ERR_RPC_BODY_PARSE_FAILED, message: 'ERR_RPC_BODY_PARSE_FAILED' };
              resolve();
              return;
            }

            try {
              const packet: IRawNetPacket = {
                opcode: OPCode.REQUEST,
                headers: req.headers,
                method: path.basename(req.url),
                payload,
                path: req.url
              };
              const requestSession = ctx.cookies.get('sora-http-session');
              const session = requestSession || uuid();

              const response = await listenerDataCallback(packet, session);
              if (!response) {
                ctx.body = {};
                await next();
                return;
              }
              ctx.res.setHeader('Content-Type', 'application/json');
              for (const [header, content] of Object.entries(response.headers)) {
                if (typeof content === 'string') {
                  ctx.res.setHeader(header, content);
                }
              }
              if (requestSession !== session) {
                ctx.cookies.set('sora-http-session', session);
              }
              ctx.body = JSON.stringify(response.payload || {});
              await next();
            } catch (err) {
              Runtime.frameLogger.error('listener.http', err, { event: 'event-handle-rpc', error: Logger.errorMessage(err)});
              ctx.body = { error: err.code || RPCErrorCode.ERR_RPC_UNKNOWN, message: err.message };
            }
            resolve();
          };

          req.on('end', handleReq);
        });
      });
    });
  }

  protected async listen() {
    if (this.options_.portRange)
      await this.listenRange(this.options_.portRange[0], this.options_.portRange[1]);

    if (this.options_.port) {
      this.usePort_ = this.options_.port;

      await util.promisify<number, string, void>(this.httpServer_.listen.bind(this.httpServer_))(this.usePort_, this.options_.host);

      this.httpServer_.on('error', this.onServerError.bind(this));
    }

    return {
      id: this.id,
      protocol: 'http',
      endpoint: `${this.options_.host}:${this.usePort_}`,
    }
  }

  private onServerError(err: Error) {
    this.lifeCycle_.setState(ListenerState.ERROR, err);
    Runtime.frameLogger.error('listener.http', err, {event: 'http-server-on-error', error: Logger.errorMessage(err)});
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

        this.httpServer_.on('error', this.onServerError.bind(this));
        resolve();
      });

      this.httpServer_.listen(this.usePort_, this.options_.host);
    });
  }

  protected async shutdown() {
    await util.promisify(this.httpServer_.close.bind(this.httpServer_))();
  }

  private httpServer_: http.Server;
  private koa_: Koa;
  private options_: IHTTPListenerOptions;
  private usePort_: number;
}

export {HTTPListener}
