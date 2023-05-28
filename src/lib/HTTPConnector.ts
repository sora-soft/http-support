import {Connector, ConnectorState, ExError, IListenerInfo, IRawNetPacket, IRawReqPacket, IRawResPacket, IResPayloadPacket, Logger, OPCode, RPCError, RPCErrorCode, RPCHeader, RPCSender, Runtime} from '@sora-soft/framework';
import axios, {AxiosHeaders, AxiosInstance} from 'axios';
import Koa from 'koa';
import cookie from 'cookie';
import {HTTPError} from './HTTPError.js';
import {HTTPErrorCode} from './HTTPErrorCode.js';
import {TypeGuard} from '@sora-soft/type-guard';
import {HTTPHeader} from './HTTPHeader.js';

export type KOAContext = Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext, any>;
export interface IHttpRawResponse<T> {
  status: number;
  headers: {
    [k: string]: string;
  };
  payload: T;
}

class HTTPConnector extends Connector {
  static register() {
    Runtime.pvdManager.registerSender('http', (listenerId: string, targetId: string, weight) => {
      return new RPCSender(listenerId, targetId, new HTTPConnector(), weight);
    });
  }

  constructor(ctx?: KOAContext) {
    super({
      ping: {enabled: false}
    });
    this.ctx_ = null;
    this.client_ = null;
    this.ctxPromise_ = null;
    if (ctx) {
      this.ctx_ = ctx;

      this.lifeCycle_.setState(ConnectorState.READY);
      this.target_ = {
        protocol: 'http',
        endpoint: `${ctx.request.ip}`,
        labels: {},
      };

      this.handleCtx(ctx);
      this.ctxPromise_ = new Promise<void>((resolve) => {
        this.endCallback_ = resolve;
      });
    }
  }

  isAvailable() {
    return true;
  }

  protected async connect(listenInfo: IListenerInfo) {
    this.client_ = axios.create({
      baseURL: `${listenInfo.protocol}://${listenInfo.endpoint}`,
      withCredentials: true,
    });
    return;
  }

  protected async disconnect(): Promise<void> {
    this.client_ = null;
  }

  async sendRaw(packet: IHttpRawResponse<unknown>) {
    if (this.ctx_) {
      this.ctx_.cookies.set('sora-http-session', this.session);
      for (const [header, value] of Object.entries(packet.headers)) {
        this.ctx_.res.setHeader(header, value);
      }
      this.ctx_.res.setHeader('Content-Type', 'application/json');
      this.ctx_.status = packet.status;
      this.ctx_.body = JSON.stringify(packet.payload || {});
    } else {
      throw new HTTPError(HTTPErrorCode.ERR_HTTP_NOT_SUPPORT_RAW, 'ERR_HTTP_NOT_SUPPORT_RAW');
    }
  }

  async send(packet: IRawNetPacket) {
    if (this.ctx_) {
      if (!TypeGuard.is<IRawResPacket<unknown>>(packet)) {
        throw new HTTPError(HTTPErrorCode.ERR_HTTP_NOT_SUPPORT_SEND_REQUEST, 'ERR_HTTP_NOT_SUPPORT_SEND_REQUEST');
      }
      this.ctx_.res.setHeader('Content-Type', 'application/json');
      if (this.session)
        this.ctx_.res.setHeader('sora-http-session', this.session);

      for (const [header, content] of Object.entries(packet.headers)) {
        if (header === HTTPHeader.HttpResStatusCodeHeader) {
          this.ctx_.status = content as number;
          continue;
        }
        if (typeof content === 'string') {
          this.ctx_.res.setHeader(header, content);
        }
      }
      this.ctx_.body = JSON.stringify(packet.payload || {});
    } else {
      if (!this.client_) {
        throw new RPCError(RPCErrorCode.ERR_RPC_TUNNEL_NOT_AVAILABLE, `ERR_RPC_TUNNEL_NOT_AVAILABLE, endpoint=${this.target_?.endpoint || 'unknown'}`);
      }

      if (!TypeGuard.is<IRawReqPacket>(packet)) {
        throw new HTTPError(HTTPErrorCode.ERR_HTTP_CONNECTOR_ONLY_SPPORT_REQUEST, 'ERR_HTTP_CONNECTOR_ONLY_SPPORT_REQUEST');
      }

      const headers = packet.headers;
      if (this.session) {
        headers.cookie = `sora-http-session=${this.session}`;
      }

      const res = await this.client_.post(`${packet.service}/${packet.method}`, packet.payload, {
        headers: headers as AxiosHeaders,
      });

      if (res.status !== axios.HttpStatusCode.Ok) {
        throw new RPCError(RPCErrorCode.ERR_RPC_UNKNOWN, res.statusText);
      }

      if (res.headers['set-cookie']) {
        if (Array.isArray(res.headers['set-cookie'])) {
          for (const c of res.headers['set-cookie']) {
            const newCookie = cookie.parse(c);
            if (newCookie['sora-http-session']) {
              this.session_ = newCookie['sora-http-session'];
            }
          }
        } else {
          const newCookie = cookie.parse(res.headers['set-cookie']);
          if (newCookie['sora-http-session']) {
            this.session_ = newCookie['sora-http-session'];
          }
        }
      }

      const response: IRawResPacket = {
        opcode: OPCode.RESPONSE,
        headers: res.headers,
        payload: res.data as IResPayloadPacket<unknown>,
      };
      this.emitRPCResponse(response);
    }
  }

  private handleCtx(ctx: KOAContext) {
    const req = ctx.req;
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });
    const handleReq = async () => {
      if (ctx.method === 'OPTIONS') {
        ctx.response.status = 200;
        await this.endCtx();
        return;
      }

      let payload = {};
      switch(ctx.method) {
        case 'GET': {
          payload = ctx.query;
          break;
        }
        case 'PUT':
        case 'POST': {
          try {
            payload = JSON.parse(body) as Object;
          } catch (e) {
            const err = ExError.fromError(e as Error);
            Runtime.frameLogger.debug('connector.http', err, {event: 'parse-body-failed', error: Logger.errorMessage(err)});
            ctx.body = {
              error: {
                code: RPCErrorCode.ERR_RPC_BODY_PARSE_FAILED,
                level: err.level,
                message: RPCErrorCode.ERR_RPC_BODY_PARSE_FAILED,
                name: err.name,
              },
              result: null
            };
            await this.endCtx();
            return;
          }
          break;
        }
      }

      if (!req.url) {
        Runtime.frameLogger.debug('connector.http', {event: 'req-no-url'});
        await this.endCtx();
        return;
      }

      const pathArray = req.url.split('/');
      const method = pathArray.at(-1);
      const service = pathArray.at(-2) || '';
      if (!method) {
        Runtime.frameLogger.debug('connector.http', {event: 'parse-url-failed', url: req.url});
        return;
      }

      const packet: IRawNetPacket = {
        opcode: OPCode.REQUEST,
        headers: {
          ...req.headers,
          [RPCHeader.RPC_ID_HEADER]: 1,
          [HTTPHeader.HttpMethodHeader]: ctx.method.toLocaleLowerCase(),
        },
        method,
        service,
        payload,
      };

      await this.handleIncomeMessage(packet, this.session, this);
      await this.endCtx();
    };

    req.on('end', handleReq);
  }

  private async endCtx() {
    if (this.endCallback_) {
      this.endCallback_();
    }
    await this.off();
  }

  get promise() {
    return this.ctxPromise_;
  }

  get protocol() {
    return 'http';
  }

  private ctx_: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext, any> | null;
  private ctxPromise_: Promise<void> | null;
  private client_: AxiosInstance | null;
  private endCallback_?: () => void;
}

export {HTTPConnector};
