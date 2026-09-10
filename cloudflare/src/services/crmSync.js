// Pushes WhatsApp bot leads into the PSG CRM (Supabase, table crm_clients) as Lead records.
// Runs ALONGSIDE the existing Google Sheets logging in sheets.js — this does not replace it,
// and it never touches sheets.js. Called from crm.js's saveCustomerLead().
//
// Sync scope is deliberately narrow: only lead/contact info (name, company, phone, city,
// product interest) goes into the CRM — never the raw chat transcript (that stays in the
// Sheet's Inquiries tab only, and in crm_calls/crm_meetings which reps fill in themselves).
//
// Every call is wrapped by the caller in try/catch, and every Supabase call in here is too —
// a CRM outage must never stop the bot from replying to the customer or logging to Sheets.

const CLIENTS_TABLE = 'crm_clients'

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '')
}

function last10Digits(s) {
  return digitsOnly(s).slice(-10)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function buildNotesBlock(lead) {
  const stamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' })
  const lines = [`WhatsApp Bot inquiry — ${stamp}`]
  if (lead.glassType) lines.push(`Product: ${lead.glassType}`)
  if (lead.thermalBreak) lines.push(`Frame: ${lead.thermalBreak}`)
  if (lead.windowType) lines.push(`Style: ${lead.windowType}`)
  if (lead.size) lines.push(`Size: ${lead.size}`)
  if (lead.quantity) lines.push(`Qty: ${lead.quantity}`)
  if (lead.attachment) lines.push(`Attachment: ${lead.attachment}`)
  return lines.join('\n')
}

async function sbFetch(env, path, options = {}) {
  const url = `${env.SB_URL}/rest/v1/${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: env.SB_KEY,
      Authorization: `Bearer ${env.SB_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${text}`)
  }
  return res.status === 204 ? null : res.json()
}

// Looks up an existing crm_clients row for this phone number: first by the id we would have
// generated for it ourselves (WA-<digits>, from a previous bot inquiry), then — so a WhatsApp
// lead that's already a manually-entered CRM record doesn't get duplicated — by phone number.
async function findExistingClient(env, phone, waId) {
  let rows = await sbFetch(env, `${CLIENTS_TABLE}?id=eq.${encodeURIComponent(waId)}&select=id,notes&limit=1`)
  if (rows && rows.length) return rows[0]

  const last10 = last10Digits(phone)
  if (!last10) return null
  rows = await sbFetch(env, `${CLIENTS_TABLE}?phone=ilike.*${last10}*&select=id,notes&limit=1`)
  return rows && rows.length ? rows[0] : null
}

export async function pushLeadToCrm(env, lead) {
  if (!env.SB_URL || !env.SB_KEY) return // CRM sync not configured for this environment — skip quietly
  if (!lead || !lead.phone) return

  const waId = `WA-${digitsOnly(lead.phone)}`
  const noteBlock = buildNotesBlock(lead)

  const existing = await findExistingClient(env, lead.phone, waId)

  if (existing) {
    // Existing record (bot-created or already in the CRM some other way): append this inquiry
    // to notes and bump last_contact, but never touch status/priority/assigned_to/record_type —
    // those belong to whichever rep is already working the record.
    const mergedNotes = existing.notes ? `${existing.notes}\n\n${noteBlock}` : noteBlock
    await sbFetch(env, `${CLIENTS_TABLE}?id=eq.${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ notes: mergedNotes, last_contact: todayISO() })
    })
    return
  }

  const trimmedCompany = (lead.company || '').trim()
  const companyName = trimmedCompany && trimmedCompany.toLowerCase() !== 'none'
    ? trimmedCompany
    : `${lead.name || 'WhatsApp Lead'} (Individual)`

  await sbFetch(env, CLIENTS_TABLE, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: waId,
      company: companyName,
      contact: lead.name || '',
      designation: null,
      phone: lead.phone,
      email: null,
      city: lead.city || '',
      industry: null,
      lead_source: 'WhatsApp Bot',
      priority: 'Medium',
      assigned_to: null,
      first_contact: todayISO(),
      last_contact: todayISO(),
      status: 'Follow-Up Required',
      notes: noteBlock,
      revenue_potential: null,
      record_type: 'Lead',
      active: true
    })
  })
}
