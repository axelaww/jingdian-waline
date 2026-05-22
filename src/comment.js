const mysql = require('mysql2/promise');

// TiDB Cloud connection config
const DB_CONFIG = {
  host: 'gateway01.ap-southeast-1.prod.alicloud.tidbcloud.com',
  port: 4000,
  user: '2LT2FE34TSTAJUf.root',
  password: 'UmvWa6ZeWecNTbPt',
  database: 'waline',
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

// CORS headers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data, status) {
  status = status || 200;
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  };
}

// Parse path
function parsePath(path) {
  // Remove /.netlify/functions/comment prefix
  var clean = path.replace(/^\/\.netlify\/functions\/comment\/?/, '');
  if (!clean) clean = '/';
  if (clean[0] !== '/') clean = '/' + clean;
  return clean;
}

exports.handler = async function(event, context) {
  var method = event.httpMethod;
  var path = parsePath(event.path);
  var body = null;

  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      body = {};
    }
  }

  // Handle OPTIONS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Waline comment APIs
  if (method === 'GET' && path.match(/^\/comment/)) {
    return handleGetComments(event);
  }

  if (method === 'POST' && path.match(/^\/comment/)) {
    return handlePostComment(body, event);
  }

  if (method === 'POST' && path.match(/^\/counter/)) {
    return handleCounter(body);
  }

  if (method === 'GET' && path.match(/^\/counter/)) {
    return handleGetCounter(event);
  }

  // Fallback
  return json({ errno: 0, data: [] });
};

async function handleGetComments(event) {
  var conn;
  try {
    var qp = event.queryStringParameters || {};
    var uri = qp.uri || qp.url || '';
    var page = parseInt(qp.page) || 1;
    var pageSize = parseInt(qp.pageSize) || 10;
    var offset = (page - 1) * pageSize;

    conn = await getPool().getConnection();

    var [rows] = await conn.query(
      'SELECT object_id as objectId, nick, mail, link, comment, inserted_at as insertedAt, ' +
      'pid, rid, ua, ip, sticky, status FROM wl_Comment WHERE url = ? ' +
      'ORDER BY inserted_at DESC LIMIT ? OFFSET ?',
      [uri, pageSize, offset]
    );

    var [countResult] = await conn.query(
      'SELECT COUNT(*) as total FROM wl_Comment WHERE url = ?', [uri]
    );
    var total = countResult[0].total;

    conn.release();

    return json({
      errno: 0,
      data: {
        page: page,
        pageSize: pageSize,
        totalPages: Math.ceil(total / pageSize),
        count: total,
        data: rows || [],
      },
    });
  } catch (err) {
    if (conn) conn.release();
    console.error('GET comments error:', err.message);
    return json({ errno: 1, errmsg: err.message, data: [] });
  }
}

async function handlePostComment(body, event) {
  var conn;
  try {
    var uri = body.url || body.uri || '';
    var nick = body.nick || 'Anonymous';
    var mail = body.mail || '';
    var link = body.link || '';
    var comment = body.comment || '';
    var pid = body.pid || null;
    var rid = body.rid || null;
    var ua = (event.headers || {})['user-agent'] || '';
    var ip = (event.headers || {})['x-forwarded-for'] || '';

    if (!uri || !comment.trim()) {
      return json({ errno: 1, errmsg: 'url and comment are required' });
    }

    conn = await getPool().getConnection();

    var [result] = await conn.query(
      'INSERT INTO wl_Comment (object_id, url, nick, mail, link, comment, pid, rid, ua, ip, status, sticky) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uri, uri, nick, mail, link, comment, pid, rid, ua, ip, 'approved', 0]
    );

    conn.release();

    return json({
      errno: 0,
      data: {
        objectId: result.insertId,
        nick: nick,
        mail: mail,
        link: link,
        comment: comment,
        pid: pid,
        rid: rid,
        insertedAt: new Date().toISOString(),
        status: 'approved',
        sticky: 0,
      },
    });
  } catch (err) {
    if (conn) conn.release();
    console.error('POST comment error:', err.message);
    return json({ errno: 1, errmsg: err.message });
  }
}

async function handleCounter(body) {
  var conn;
  try {
    var uri = body.url || '';
    var type = body.type || 'reaction';

    if (!uri) {
      return json({ errno: 1, errmsg: 'url is required' });
    }

    conn = await getPool().getConnection();

    if (type === 'reaction') {
      var reaction = body.reaction || '';
      var inc = body.action === 'inc' ? 1 : -1;

      await conn.query(
        'UPDATE wl_Counter SET time = time + ? WHERE url = ? AND type = ?',
        [inc, uri, type]
      );

      var [rows] = await conn.query(
        'SELECT time FROM wl_Counter WHERE url = ? AND type = ?', [uri, type]
      );

      if (rows.length === 0) {
        await conn.query(
          'INSERT INTO wl_Counter (url, type, time) VALUES (?, ?, 1)', [uri, type]
        );
        conn.release();
        return json({ errno: 0, data: { time: 1 } });
      }

      conn.release();
      return json({ errno: 0, data: { time: rows[0].time } });
    } else {
      // page view counter
      var [rows] = await conn.query(
        'SELECT time FROM wl_Counter WHERE url = ? AND type = ?', [uri, type]
      );

      if (rows.length === 0) {
        await conn.query(
          'INSERT INTO wl_Counter (url, type, time) VALUES (?, ?, 1)', [uri, type]
        );
        conn.release();
        return json({ errno: 0, data: { time: 1 } });
      }

      await conn.query(
        'UPDATE wl_Counter SET time = time + 1 WHERE url = ? AND type = ?',
        [uri, type]
      );

      var [updated] = await conn.query(
        'SELECT time FROM wl_Counter WHERE url = ? AND type = ?', [uri, type]
      );

      conn.release();
      return json({ errno: 0, data: { time: updated[0].time } });
    }
  } catch (err) {
    if (conn) conn.release();
    console.error('Counter error:', err.message);
    return json({ errno: 1, errmsg: err.message });
  }
}

async function handleGetCounter(event) {
  var conn;
  try {
    var qp = event.queryStringParameters || {};
    var uri = qp.url || '';

    if (!uri) {
      return json({ errno: 1, errmsg: 'url is required' });
    }

    conn = await getPool().getConnection();

    var [rows] = await conn.query(
      'SELECT type, time FROM wl_Counter WHERE url = ?', [uri]
    );

    conn.release();

    var result = {};
    for (var i = 0; i < rows.length; i++) {
      result[rows[i].type] = rows[i].time;
    }

    return json({ errno: 0, data: result });
  } catch (err) {
    if (conn) conn.release();
    console.error('GET counter error:', err.message);
    return json({ errno: 0, data: {} });
  }
}
