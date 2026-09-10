function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

module.exports = asyncRoute;
