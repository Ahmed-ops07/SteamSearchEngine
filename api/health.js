'use strict';

const { handleHealth } = require('../server');

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return handleHealth(res);
};
