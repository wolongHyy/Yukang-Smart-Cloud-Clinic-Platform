class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.code = code || 'HTTP_ERROR';
    }
}

module.exports = HttpError;
