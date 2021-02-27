import {ExError} from '@sora-soft/framework';
import {HTTPErrorCode} from './HTTPErrorCode';

class HTTPError extends ExError {
  constructor(code: HTTPErrorCode, message: string) {
    super(code, message);
    Object.setPrototypeOf(this, HTTPError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export {HTTPError};
