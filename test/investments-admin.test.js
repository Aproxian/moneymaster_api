const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { assertAdminUnlessCron } = require("../src/routes/investments");

const originalAdminEmail = process.env.ADMIN_EMAIL;

afterEach(() => {
  if (originalAdminEmail === undefined) {
    delete process.env.ADMIN_EMAIL;
  } else {
    process.env.ADMIN_EMAIL = originalAdminEmail;
  }
});

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("JWT investment refresh requests fail closed when ADMIN_EMAIL is unset", async () => {
  delete process.env.ADMIN_EMAIL;
  const res = makeRes();

  const ok = await assertAdminUnlessCron(
    { refreshDailyCron: false, auth: { userId: "user-1" } },
    res
  );

  assert.equal(ok, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "ADMIN_EMAIL is not configured on the server" });
});

test("cron-authenticated investment refresh requests bypass ADMIN_EMAIL", async () => {
  delete process.env.ADMIN_EMAIL;
  const res = makeRes();

  const ok = await assertAdminUnlessCron({ refreshDailyCron: true, auth: { userId: null } }, res);

  assert.equal(ok, true);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, null);
});
