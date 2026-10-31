'use strict';

const { handlePoster } = require('../server');

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return handlePoster(url.searchParams, res);
};
