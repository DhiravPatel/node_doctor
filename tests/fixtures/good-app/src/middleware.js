// Wraps an async handler so a post-await rejection is routed to Express error
// handling instead of hanging the request.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
