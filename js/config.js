/* ============================================================
   MWT Installer Order Manager - config.js
   Edit the values below to change who receives submitted jobs.
   No other file needs to change when these addresses change.
   ============================================================ */

const MWT_CONFIG = {
  // Where Submit & Send actually delivers the finished PDF.
  //
  // The app cannot send real email with an attachment on its own - there
  // is no SMTP capability in a browser, and embedding an email
  // credential directly in this file would expose it to anyone who
  // views the page source. This URL points at a small Google Apps
  // Script "Web App" (see mwt-submit-backend/Code.gs) that receives the
  // PDF and actually emails it - the real recipient addresses live only
  // in that script, never here.
  //
  // CHANGE THIS to your deployed Apps Script Web App URL. It looks like:
  //   https://script.google.com/macros/s/AKfycb.../exec
  submitApiUrl: "https://script.google.com/macros/s/AKfycbxVhAo4XBokM5kkd7LurgDMBdQbbxKWfrYwfiu8t7mNDT4sNRSKeB7O9gIXxMfeZMDu_A/exec",

  // Where this iPad's INSTALLER device authorization token is
  // remembered once it's been unlocked with the shared PIN - see
  // app.js. Nothing about the PIN itself, or which devices are
  // authorized, is ever stored in this file; the correct PIN lives only
  // in Code.gs's Script Properties, and the list of authorized device
  // tokens lives only on the Apps Script server. This is just the
  // localStorage key name used to remember THIS device's own token once
  // it's been issued. (Unchanged from the previous version, so existing
  // authorized installer iPads are not logged out by this update.)
  deviceTokenStorageKey: "mwt_device_token",

  // Same idea, for the separate Administrator role's token - a
  // completely different key so an Installer token and an Admin token
  // are never confused with each other on the same device.
  adminTokenStorageKey: "mwt_admin_token",

  // The Designer's email is collected on each job (Sold To / Bill To
  // section) and IS one of the Submit & Send recipients when it's
  // present and valid - always in addition to, never instead of, the
  // three fixed company addresses hard-coded server-side in
  // mwt-submit-backend-gas/Code.gs. The app never sends an arbitrary
  // recipient list - only this one optional address.

  // How long (in days) a SUBMITTED job's local copy (including its
  // photos) is kept on this device before being automatically removed
  // to keep local storage from growing forever. Drafts are NEVER
  // auto-deleted, regardless of age - only jobs that were successfully
  // submitted. The central Drive/Sheet archive is unaffected by this;
  // Admins can still see the job there long after it's gone locally.
  submittedJobRetentionDays: 60,

  // MWT's fixed shipping/receiving info, printed on every form
  // (matches the current MWT paper/website forms).
  // NOTE: Matthew's 2026 written spec confirms the Ship To phone is
  // 847-710-1172, distinct from the general company/sales phone
  // (847-732-8552) shown in the form header and footer.
  shipTo: {
    companyName: "Motorized Window Treatments",
    contact: "Receiving",
    street: "1521 Bourbon Parkway",
    cityStateZip: "Streamwood, IL 60107",
    phone: "847-710-1172",
    shippingNotes:
      "ORDERS CAN BE RECEIVED at the above address between the hours of 9am - 4pm Monday - Friday. If receiving arrangements need to be made please call the above number."
  },

  companyPhone: "847-732-8552",

  // Roughly how large (in bytes) a job's attachments can get before we
  // warn the installer that offline storage may be getting tight.
  attachmentWarningBytes: 15 * 1024 * 1024, // 15 MB per job

  appVersion: "1.4"
};
