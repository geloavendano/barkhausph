import { sbPatch, sbPost } from './supabase'

export function adminDisplayName(admin) {
  return admin?.name || admin?.email || 'Admin'
}

export function adminSnapshot(admin) {
  return {
    admin_user_id: admin?.adminUserId ?? null,
    auth_user_id:  admin?.authUserId ?? null,
    name:          adminDisplayName(admin),
    email:         admin?.email ?? null,
  }
}

export function bookingCreatedAudit(admin) {
  return {
    created_by_admin_id:      admin?.adminUserId ?? null,
    created_by_auth_user_id:  admin?.authUserId ?? null,
    created_by_admin_name:    adminDisplayName(admin),
    created_by_admin_email:   admin?.email ?? null,
  }
}

export function bookingEditAudit(admin) {
  return {
    edited_by_name:          adminDisplayName(admin),
    edited_by_admin_id:      admin?.adminUserId ?? null,
    edited_by_auth_user_id:  admin?.authUserId ?? null,
    edited_by_email:         admin?.email ?? null,
  }
}

export function paymentAudit(admin) {
  return {
    recorded_by:             adminDisplayName(admin),
    recorded_by_admin_id:    admin?.adminUserId ?? null,
    recorded_by_auth_user_id: admin?.authUserId ?? null,
    recorded_by_email:       admin?.email ?? null,
  }
}

function isAuditSchemaError(err) {
  return /schema cache|PGRST204|column|created_by_|edited_by_|recorded_by_|admin_id|auth_user_id/i.test(err?.message ?? '')
}

function stripAuditColumns(body) {
  const auditColumns = new Set([
    'created_by_admin_id',
    'created_by_auth_user_id',
    'created_by_admin_name',
    'created_by_admin_email',
    'edited_by_admin_id',
    'edited_by_auth_user_id',
    'edited_by_email',
    'recorded_by_admin_id',
    'recorded_by_auth_user_id',
    'recorded_by_email',
  ])
  const copy = Array.isArray(body)
    ? body.map(row => ({ ...row }))
    : { ...body }
  const rows = Array.isArray(copy) ? copy : [copy]
  rows.forEach(row => {
    Object.keys(row).forEach(key => {
      if (auditColumns.has(key)) delete row[key]
    })
  })
  return copy
}

export async function sbPostAudit(table, body) {
  try {
    return await sbPost(table, body)
  } catch (err) {
    if (!isAuditSchemaError(err)) throw err
    return await sbPost(table, stripAuditColumns(body))
  }
}

export async function sbPatchAudit(table, filter, body) {
  try {
    return await sbPatch(table, filter, body)
  } catch (err) {
    if (!isAuditSchemaError(err)) throw err
    return await sbPatch(table, filter, stripAuditColumns(body))
  }
}
