// 统一的错误类型：{ code, message, status }。code 用于界面文案与降级判断。
export class ApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}
