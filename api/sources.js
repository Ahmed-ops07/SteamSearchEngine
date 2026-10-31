'use strict';

const { handleSources } = require('../server');

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return handleSources(res);
};
