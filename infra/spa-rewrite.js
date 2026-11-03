// CloudFront Function, viewer-request, on the S3 behaviour only (the API
// behaviours match first and never reach it).
//
// A deep link such as /briefs/abc is not an object in the bucket. Without this
// it reached S3, came back 403, and the custom error response turned that into
// the shell — correct, but an error response CloudFront serves slowly even
// from cache (~0.7 s measured, against 0.04 s for a plain hit). Rewriting the
// path before the cache lookup makes every deep link an ordinary hit of
// /index.html, and one invalidation of /index.html refreshes them all.
//
// Paths whose last segment has an extension (assets, favicon, robots.txt) pass
// through unchanged.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
