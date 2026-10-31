'use strict';

const { handleSearch, sendJson } = require('../server');

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    return await handleSearch(url.searchParams, res);
  } catch (e) {
    console.error('search failed:', e);
    return sendJson(res, 500, { error: 'Search failed: ' + (e.message || e) });
  }
};
