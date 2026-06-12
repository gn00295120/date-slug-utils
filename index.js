module.exports = {
  formatDate: (d) => d.toISOString().split('T')[0],
  slugify: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  truncate: (s, n) => s.length > n ? s.substring(0, n) + '...' : s,
};
