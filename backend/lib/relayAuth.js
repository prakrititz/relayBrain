const { getProjectByApiKey } = require('./relayProjects');

function getApiKey() {
  return process.env.RELAY_API_KEY || '';
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.headers['x-relay-api-key'] || '';
}

function requireApiKey(req, res, next) {
  const globalKey = process.env.RELAY_API_KEY || '';
  const token = extractToken(req);

  if (globalKey && token === globalKey) return next();

  const project = getProjectByApiKey(token);
  if (project) {
    req.relayProject = project;
    return next();
  }

  if (!globalKey && !token) return next();

  return res.status(401).json({
    error: 'Invalid or missing API key. Use your project API key from the Relay dashboard.',
  });
}

function isAuthEnabled() {
  return Boolean(process.env.RELAY_API_KEY);
}

module.exports = {
  getApiKey,
  requireApiKey,
  isAuthEnabled,
  extractToken,
};
