// Thin fetch helpers; every call returns { status, body } so callers can
// reason about shape without parsing ad-hoc JSON.
export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: data };
}

export async function get(path) {
  const res = await fetch(path);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: data };
}
