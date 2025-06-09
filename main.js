// =========================
// ========== HELPERS ======
// =========================

// Parse CSV with PapaParse, skip empty lines, return as array-of-arrays.
function parseCSVFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: r => { resolve(r.data.slice(1).filter(r => r.length > 1)); },
      error: reject
    });
  });
}

// Converts various string values to boolean.
function parseBoolean(v) {
  return v?.trim().toLowerCase() === 'true';
}

// Returns seconds between two timestamp strings.
function timestampDiff(a, b) {
  if (!a || !b) return 0;
  return Math.round(
    (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 1000
  );
}

function clampTardiness(raw, d) {
  const MIN = -3600, MAX = d;
  return raw < MIN ? MIN : raw > MAX ? MAX : raw;
}

function unique(arr) {
  return [...new Set(arr)];
}

// =========================
// == DATA NORMALIZATION ===
// =========================

// Converts raw CSV data into structured objects keyed by class slug
function processData(classesData, participantsData) {
  const out = {};

  classesData.forEach(cs => {
    const slug = cs[6];
    if (!slug) return;

    const scheduledStart = cs[0];
    const scheduledDuration = timestampDiff(cs[0], cs[1]);
    const cancelledBy = cs[22] || '';
    const cancelledTime = cs[23] || '';

    const cls = {
      scheduledStart,
      scheduledDuration,
      company: cs[5],
      course_id: cs[29],
      available_seats: parseInt(cs[10], 10),
      cancelledBy,
      cancelledTime,
      cancelledByStudent: false,
      cancelledByTeacher: false,
      cancelledByAdmin: false,
      cancelledInterval: '',
      teacher: {},
      students: []
    };

    // Find participants
    const parts = participantsData.filter(p => p[2] === slug);
    const enrolled = parts.filter(p => !(p[9]?.trim().toLowerCase() === 'true'));

    cls.students = enrolled.map(pr => {
      const enrolledAt = pr[22];
      const studentCancelledTime = pr[14];

      return {
        username: pr[4],
        attended: parseBoolean(pr[10]),
        tardiness: clampTardiness(timestampDiff(pr[3], pr[11]), scheduledDuration),
        cancelled: parseBoolean(pr[12]),
        cancelledBy: pr[13] || '',
        cancelledTime: studentCancelledTime,
        cancelledInterval: studentCancelledTime
          ? (timestampDiff(studentCancelledTime, scheduledStart) / 3600).toFixed(2)
          : '',
        enrolledTime: enrolledAt,
        enrolmentInterval: enrolledAt
          ? (timestampDiff(enrolledAt, scheduledStart) / 3600).toFixed(2)
          : '',
        rating: pr[15],
        feedback: pr[16]
      };
    });

    // Find teacher
    const teacherRow = parts.find(p => p[9]?.trim().toLowerCase() === 'true');
    if (teacherRow) {
      cls.teacher = {
        username: teacherRow[4],
        attended: parseBoolean(teacherRow[10]),
        tardiness: clampTardiness(timestampDiff(teacherRow[3], teacherRow[11]), scheduledDuration),
        cancelled: parseBoolean(teacherRow[12])
      };
    }

    // Cancellation info
    const teacherName = cls.teacher?.username;
    const studentNames = cls.students.map(s => s.username);

    if (cancelledBy) {
      cls.cancelledByStudent = studentNames.includes(cancelledBy);
      cls.cancelledByTeacher = cancelledBy === teacherName;
      cls.cancelledByAdmin = !cls.cancelledByStudent && !cls.cancelledByTeacher;
      cls.cancelledInterval = cancelledTime
        ? (timestampDiff(cancelledTime, scheduledStart) / 3600).toFixed(2)
        : '';
    }

    out[slug] = cls;
  });

  return out;
}

// =========================
// == REPORT BUILDERS ======
// =========================

// --- TEACHER HOUR COUNT REPORT ---
function buildTeacherHourCountCSV(processedData, settings, simpleReport) {
  // Unpack settings object
  const {
    tardinessLimit,
    cancellationWindow,
    penaliseTardiness,
    payLastMinuteCancellation,
    payStudentNoShow,
    studentNoShowRate,
    classTypeFilter
  } = settings;
  const studentNoShowFrac = (payStudentNoShow ? (studentNoShowRate / 100) : 0);

  let teacherReports = {}, durationsSet = new Set();

  // 1. Aggregate per-class data
  for (let slug in processedData) {
    const cls = processedData[slug];
    const durMin = Math.round(cls['scheduledDuration'] / 60);
    durationsSet.add(durMin);

    const t = cls.teacher.username;
    if (!t) continue;
    const type = (cls['available_seats'] === 1) ? 'private' : 'group';
    if (classTypeFilter !== 'both' && classTypeFilter !== type) continue;

    teacherReports[t] = teacherReports[t] || { durations: {} };
    const durs = teacherReports[t].durations;
    if (!durs[durMin]) {
      durs[durMin] = {
        private: { attended: 0, noShow: 0, cancelled: 0, late: 0, studentNoShow: 0 },
        group:   { attended: 0, noShow: 0,               late: 0, studentNoShow: 0 }
      };
    }
    const bucket = durs[durMin][type];

    const teacherAttended  = Boolean(cls.teacher.attended);
    const teacherCancelled = Boolean(cls.teacher.cancelled);
    const tLateMin         = Math.round(cls.teacher.tardiness / 60);

    // Late student cancellations (private + within window)
    if (type === 'private' && payLastMinuteCancellation && Array.isArray(cls.students)) {
      for (let s of cls.students) {
        if (s.cancelled && s['cancelled by'] !== t) {
          if (timestampDiff(cls['scheduledStart'], s['cancelled time']) / 3600 < cancellationWindow) {
            bucket.cancelled++;
            break;
          }
        }
      }
    }

    if (teacherAttended) {
      bucket.attended++;
      if (penaliseTardiness && tLateMin > tardinessLimit) bucket.late++;
    } else {
      bucket.noShow++;
    }

    if (
      teacherAttended &&
      !teacherCancelled &&
      Array.isArray(cls.students) &&
      cls.students.length > 0 &&
      cls.students.every(s => !s.attended)
    ) {
      bucket.studentNoShow++;
    }
  }

  // 2. CSV Header/Columns
  const durations = Array.from(durationsSet).sort((a, b) => a - b);
  const header = ['teacher'];
  const makeCols = (type) => {
    durations.forEach(d => {
      if (simpleReport) {
        header.push(`${d}min ${type} classes count`);
      } else {
        header.push(`${d}min ${type} classes attended`);
        if (type === 'private') header.push(`${d}min ${type} classes cancelled < ${cancellationWindow}h`);
        header.push(`${d}min ${type} classes no show`);
        header.push(`${d}min ${type} student no show`);
        header.push(`${d}min ${type} classes late`);
        header.push(`${d}min ${type} classes count`);
      }
    });
    header.push(`Total ${type} classes count`);
    header.push(`Total ${type} minutes`);
  };
  if (classTypeFilter === 'both') {
    makeCols('private');
    makeCols('group');
  } else {
    makeCols(classTypeFilter);
  }

  // 3. Data rows
  const rows = [header.join(',')];
  for (let teacher in teacherReports) {
    const durs = teacherReports[teacher].durations;
    let row = [teacher];
    let totalPrivCount = 0, totalGrpCount = 0;
    let totalPrivMin   = 0, totalGrpMin   = 0;

    const pushType = (type) => {
      durations.forEach(d => {
        const b = (durs[d] && durs[d][type]) || { attended:0, cancelled:0, noShow:0, late:0, studentNoShow:0 };
        const baseCount = b.attended
          - (penaliseTardiness ? b.late : 0)
          + ((type==='private' && payLastMinuteCancellation) ? b.cancelled : 0);
        const deduction = b.studentNoShow * (1 - studentNoShowFrac);
        const netCount  = parseFloat((baseCount - deduction).toFixed(2));

        if (simpleReport) {
          row.push(netCount);
        } else {
          row.push(b.attended);
          if (type==='private') row.push(b.cancelled);
          row.push(b.noShow);
          row.push(b.studentNoShow);
          row.push(b.late);
          row.push(netCount);
        }

        if (type === 'private') {
          totalPrivCount += netCount;
          totalPrivMin   += netCount * d;
        } else {
          totalGrpCount += netCount;
          totalGrpMin   += netCount * d;
        }
      });
      if (type === 'private') {
        row.push(totalPrivCount, totalPrivMin);
      } else {
        row.push(totalGrpCount, totalGrpMin);
      }
    };

    if (classTypeFilter === 'both') {
      pushType('private');
      pushType('group');
    } else {
      pushType(classTypeFilter);
    }

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

// --- TEACHER OVERVIEW AND FEEDBACK REPORTS ---
function buildTeacherOverviewCSV(processedData) { /* ... unchanged ... */ }
// (You can copy-paste your existing function here)
function buildTeacherFeedbackCSV(processedData) { /* ... unchanged ... */ }

// --- COURSE OVERVIEW AND DETAIL REPORTS ---
function buildAllCoursesOverviewCSV(processedData) { /* ... unchanged ... */ }
function buildCourseDetailReport(processedData, courseId) { /* ... unchanged ... */ }

// --- STUDENT / COMPANY REPORT ---
// (as in previous assistant message, updated and organized!)
function buildStudentReport(processedData, {
  cancellationWindow,
  companyId,
  filterMode,
  customList
}) {
  // ... as in last response ...
}

// --- CLASS OVERVIEW ---
function buildOverviewData(processedData, cancellationWindow) { /* ... unchanged ... */ }
function buildPrivateAveragesTable(data) { /* ... unchanged ... */ }

// =========================
// ======= UI / STATE ======
// =========================

// Holds state needed for app operation
let data = null, courses = [], companies = [];
let validatedStudentUsernames = [];

// --- Utility: Show Only One Panel
const panels = [
  'fileUploadPanel',
  'teacherHourCountSettings',
  'overviewSettings',
  'teacherReportPanel',
  'courseReportSettings',
  'studentReportSettings',
  'hourCountReportOutput',
  'teacherReportOutput',
  'allCoursesOverviewReport',
  'courseDetailedReport',
  'studentReportOutput',
  'overviewReportOutput'
];
function show(id) {
  panels.forEach(p => document.getElementById(p).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// --- CSV Table Rendering
function csvToTable(csv) {
  const rows = csv.trim().split('\n');
  let html = '<table><thead><tr>' + rows[0].split(',').map(c => '<th>' + c.replace(/^"|"$/g, '') + '</th>').join('') + '</tr></thead><tbody>';
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split(',');
    html += '<tr>' + cols.map((c, j) => (j === 0 ?
      '<th>' + c.replace(/^"|"$/g, '') + '</th>' :
      '<td>' + c.replace(/^"|"$/g, '') + '</td>')).join('') + '</tr>';
  }
  return html + '</tbody></table>';
}

// --- UI Event Handling / Page Load
document.addEventListener('DOMContentLoaded', function() {
  // File upload logic
  const pIn = document.getElementById('participantsFile'),
        cIn = document.getElementById('classesFile'),
        upBtn = document.getElementById('uploadBtn');
  [pIn, cIn].forEach(i => i.addEventListener('change', () => {
    upBtn.disabled = !(pIn.files[0] && cIn.files[0]);
  }));
  upBtn.addEventListener('click', async () => {
    try {
      const [cData, pData] = await Promise.all([parseCSVFile(cIn.files[0]), parseCSVFile(pIn.files[0])]);
      data = processData(cData, pData);
      courses = unique(Object.values(data).map(c => c['course id']));
      companies = unique(Object.values(data).map(c => c.company).filter(Boolean));
      document.getElementById('courseSelect').innerHTML = courses.map(id => `<option>${id}</option>`).join('');
      const hasCompanies = companies.length > 0;
      // Populate company dropdown
      const companySelect = document.getElementById('companySelect');
      companySelect.innerHTML = '<option value="ALL">All</option>' + companies.map(id => `<option>${id}</option>`).join('');
      document.getElementById('companyRadio').disabled = !hasCompanies;
      // Duration checkboxes
      const durations = [...new Set(Object.values(data).map(c => Math.round(c['scheduledDuration'] / 60)))].sort((a, b) => a - b);
      const durContainer = document.getElementById('durationFilterContainer');
      durContainer.innerHTML = durations.map(d => {
        const isChecked = (d === 30 || d === 60) ? 'checked' : '';
        return `<label style="margin-right:1rem;"><input type="checkbox" name="durationFilter" value="${d}" ${isChecked}>${d} min</label>`;
      }).join('');
      validatedStudentUsernames = [];
      Object.values(data).forEach(cls => {
        (cls.students || []).forEach(s => {
          if (s.username && !validatedStudentUsernames.includes(s.username)) {
            validatedStudentUsernames.push(s.username);
          }
        });
      });
      show('reportSelectorPanel');
    } catch (e) {
      console.error(e);
      alert('Parsing error');
    }
  });
  document.getElementById('newUploadBtn').addEventListener('click', () => location.reload());

  // Report Selector
  document.getElementById('reportSelect').addEventListener('change', e => {
    const v = e.target.value;
    if (v === 'teacher_hour_count') show('teacherHourCountSettings');
    else if (v === 'overview') show('overviewSettings');
    else if (v === 'teacher_report') show('teacherReportPanel');
    else if (v === 'course_report') show('courseReportSettings');
    else if (v === 'student_report') show('studentReportSettings');
    else show('reportSelectorPanel');
  });

  // ... add your other event listeners for filters, radio, etc ...
  // * Omitted for brevity here — just copy all your UI event stuff below!

  // === Student radio & tag input logic ===
  function updateStudentRadioUI() {
    const selected = document.querySelector('input[name="studentSelection"]:checked').value;
    document.getElementById('companySelectWrapper').classList.toggle('hidden', selected !== 'company');
    document.getElementById('customListWrapper').classList.toggle('hidden', selected !== 'custom');
    document.getElementById('companySelect').disabled = (selected !== 'company');
  }
  document.querySelectorAll('input[name="studentSelection"]').forEach(radio =>
    radio.addEventListener('change', updateStudentRadioUI)
  );
  document.getElementById('addCustomStudentBtn').addEventListener('click', () => {
    const input = document.getElementById('customStudentInput');
    const tagContainer = document.getElementById('customStudentTags');
    const usernames = input.value.split(',').map(u => u.trim()).filter(u => u.length > 0);
    usernames.forEach(username => {
      if (tagContainer.querySelector(`[data-username="${username}"]`)) return;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.dataset.username = username;
      const exists = validatedStudentUsernames.includes(username);
      if (!exists) tag.classList.add('invalid');
      tag.innerHTML = exists ? username : `Username not found: ${username}`;
      const remove = document.createElement('span');
      remove.className = 'remove';
      remove.textContent = '×';
      remove.onclick = () => tag.remove();
      tag.appendChild(remove);
      tagContainer.appendChild(tag);
    });
    input.value = '';
  });
  
  // ... The rest of the UI logic goes here (copy from your working inline <script>) ...
  // * Generate button handlers, downloads, panel updates, etc.
});

// Utility: CSV downloader
function downloadCSV(csv, fn) {
  const b = new Blob([csv], { type: 'text/csv' }),
    u = URL.createObjectURL(b),
    a = document.createElement('a');
  a.href = u;
  a.download = fn;
  a.click();
  URL.revokeObjectURL(u);
}