import {ExError} from '@sora-soft/framework';
import {HTTPErrorCode} from './HTTPErrorCode.js';

class HTTPError extends ExError {
  constructor(code: HTTPErrorCode, message: string) {
    super(code, 'HTTPError', message);
    Object.setPrototypeOf(this, HTTPError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export {HTTPError};
