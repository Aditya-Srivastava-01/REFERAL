const { google } = require("googleapis");

const CANDIDATE_HEADERS = [
  "Name",
  "Email",
  "Website",
  "University",
  "Country",
  "Status",
  "Follow-up Date",
  "Next Steps",
  "Recent Score",
];

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function createSheetsClient(auth) {
  return google.sheets({ version: "v4", auth });
}

async function ensureCandidateSheet(sheets, spreadsheetId, sheetName, candidates) {
  let metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  let sheet = (metadata.data.sheets || []).find(
    (item) => item.properties.title === sheetName
  );

  if (!sheet) {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    sheet = response.data.replies[0].addSheet;
  }

  const range = `${quoteSheetName(sheetName)}!A1:I`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  if ((current.data.values || []).length > 0) {
    return { imported: false };
  }

  const values = [
    CANDIDATE_HEADERS,
    ...candidates.map((candidate) => [
      candidate.name || "",
      candidate.email || "",
      candidate.homepage || "",
      candidate.affiliation || "",
      candidate.country || "",
      candidate.email ? "To Contact" : "Needs Email",
      "",
      candidate.email ? "Review before first email" : "Add a verified email address",
      candidate.recent_score || "",
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.24, green: 0.36, blue: 0.58 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return { imported: true };
}

async function loadSheetCandidates(sheets, spreadsheetId, sheetName) {
  const range = `${quoteSheetName(sheetName)}!A1:I`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = response.data.values || [];
  if (rows.length === 0) {
    throw new Error(`The "${sheetName}" tab is empty. Run npm run sheets:setup first.`);
  }

  const headers = rows[0].map((value) => String(value).trim().toLowerCase());
  const columnIndex = (name) => headers.indexOf(name.toLowerCase());
  for (const required of ["Name", "Email", "University", "Status"]) {
    if (columnIndex(required) === -1) {
      throw new Error(`The "${sheetName}" tab is missing the "${required}" column.`);
    }
  }

  const get = (row, name) => String(row[columnIndex(name)] || "").trim();
  return rows.slice(1).map((row, offset) => ({
    name: get(row, "Name"),
    email: get(row, "Email"),
    homepage: get(row, "Website"),
    affiliation: get(row, "University"),
    country: get(row, "Country"),
    status: get(row, "Status"),
    recent_score: get(row, "Recent Score"),
    _sheetRow: offset + 2,
  }));
}

async function markCandidateSent(sheets, spreadsheetId, sheetName, rowNumber, intervalDays) {
  const followUp = new Date();
  followUp.setUTCDate(followUp.getUTCDate() + intervalDays);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!F${rowNumber}:H${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "First Email Sent",
        followUp.toISOString().slice(0, 10),
        "Awaiting reply; automatic follow-up scheduled",
      ]],
    },
  });
}

async function markCandidateReplied(sheets, spreadsheetId, sheetName, email) {
  const range = `${quoteSheetName(sheetName)}!A1:I`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = response.data.values || [];
  if (rows.length < 2) return false;

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const emailCol = headers.indexOf("email");
  const statusCol = headers.indexOf("status");
  const nextStepsCol = headers.indexOf("next steps");
  if (emailCol === -1 || statusCol === -1) return false;

  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][emailCol] || "").toLowerCase().trim() === email.toLowerCase().trim()) {
      const rowNum = i + 1;
      const updates = [];
      if (statusCol !== -1)    updates.push({ range: `${quoteSheetName(sheetName)}!F${rowNum}`, values: [["Replied"]] });
      if (nextStepsCol !== -1) updates.push({ range: `${quoteSheetName(sheetName)}!H${rowNum}`, values: [["Reply received - follow up manually"]] });

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates,
        },
      });
      return true;
    }
  }
  return false;
}

async function forceRefreshCandidateSheet(sheets, spreadsheetId, sheetName, candidates) {
  let metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  let sheet = (metadata.data.sheets || []).find(
    (item) => item.properties.title === sheetName
  );

  if (!sheet) {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    sheet = response.data.replies[0].addSheet;
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A:I`,
  });

  if (candidates.length === 0) {
    return { imported: true, count: 0 };
  }

  const values = [
    CANDIDATE_HEADERS,
    ...candidates.map((candidate) => [
      candidate.name || "",
      candidate.email || "",
      candidate.homepage || "",
      candidate.affiliation || "",
      candidate.country || "",
      candidate.email ? "To Contact" : "Needs Email",
      "",
      candidate.email ? "Review before first email" : "Add a verified email address",
      candidate.recent_score || "",
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.24, green: 0.36, blue: 0.58 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return { imported: true, count: candidates.length };
}

module.exports = {
  createSheetsClient,
  ensureCandidateSheet,
  forceRefreshCandidateSheet,
  loadSheetCandidates,
  markCandidateSent,
  markCandidateReplied,
};
