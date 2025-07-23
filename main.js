/*******************************************************************************
 * main.js
 *
 * Refactored and thoroughly commented version of your original script.
 * This file is structured into clear sections: Helpers, Data Processing,
 * Report Builders, UI State & Event Handlers, and Utility Functions.
 * All original logic is preserved; comments explain each part for readability.
 ******************************************************************************/

/* =============================================================================
   ============================ 1. HELPER FUNCTIONS =============================
   =============================================================================
*/

/*
 * parseCSVFile
 * --------------
 * Parses a CSV File object using PapaParse and returns a Promise that resolves
 * to a 2D array of rows (skipping the header row and any empty lines).
 *
 * @param {File} file - The CSV file input from an <input type="file"> element.
 * @returns {Promise<Array<Array<string>>>} - Resolves with parsed CSV data.
 */
function parseCSVFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (r) => {
        // r.data is a 2D array; remove header (first row) and any rows of length ≤ 1
        const filtered = r.data.slice(1).filter((row) => row.length > 1);
        resolve(filtered);
      },
      error: reject
    });
  });
}

/*
 * parseBoolean
 * -------------
 * Safely parse a string value into a boolean. Considers only 'true' (case-insensitive)
 * as true; anything else returns false.
 *
 * @param {string} v - The input string to parse.
 * @returns {boolean}
 */
function parseBoolean(v) {
  return v?.trim().toLowerCase() === 'true';
}

/*
 * timestampDiff
 * --------------
 * Computes the difference between two timestamp strings (format: "YYYY-MM-DD HH:MM:SS")
 * returning the difference in seconds (rounded). If either timestamp is missing, returns 0.
 *
 * @param {string} a - The earlier timestamp string.
 * @param {string} b - The later timestamp string.
 * @returns {number} Difference in seconds (b - a).
 */
function timestampDiff(a, b) {
  if (!a || !b) return 0;
  // Convert "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS" so Date can parse.
  const dateA = new Date(a.replace(' ', 'T'));
  const dateB = new Date(b.replace(' ', 'T'));
  return Math.round((dateB - dateA) / 1000);
}

/*
 * clampTardiness
 * ----------------
 * Clamps a raw tardiness value (in seconds) between a minimum (-3600) and a maximum (d).
 * Used to prevent extreme negative or overly large tardiness values.
 *
 * @param {number} raw - Raw tardiness in seconds (could be negative if student/teacher arrived early).
 * @param {number} d   - The maximum allowed tardiness (usually the scheduled duration in seconds).
 * @returns {number} A value between -3600 and d.
 */
function clampTardiness(raw, d) {
  const MIN = -3600; // Prevent more than 1 hour early
  const MAX = d;     // Cannot be later than the class duration itself
  if (raw < MIN) return MIN;
  if (raw > MAX) return MAX;
  return raw;
}

/*
 * unique
 * -------
 * Returns a new array containing only the unique elements of the input array.
 *
 * @param {Array<any>} arr
 * @returns {Array<any>}
 */
function unique(arr) {
  return [...new Set(arr)];
}


/* =============================================================================
   ========================= 2. DATA PROCESSING FUNCTION ========================
   =============================================================================
*/

/*
 * processData
 * ------------
 * Transforms raw CSV data arrays for classes and participants into a structured
 * object where each class is keyed by its slug. Each class object includes:
 *   - scheduledStart, scheduledDuration (in seconds)
 *   - company, course_id, available_seats
 *   - cancellation info (by whom, when, interval)
 *   - teacher info (username, attended, tardiness, cancelled)
 *   - students array (with per-student attendance, tardiness, cancellation, feedback)
 *
 * @param {Array<Array<string>>} classesData      Parsed rows of CLASSES.csv (excluding header)
 * @param {Array<Array<string>>} participantsData Parsed rows of PARTICIPANTS.csv (excluding header)
 * @returns {Object<string, Object>} A map of classSlug → classObject
 */
function processData(classesData, participantsData) {
  const output = {};

  classesData.forEach((cs) => {
    // The slug (unique identifier) is in column 6
    const slug = cs[6];
    if (!slug) return; // Skip rows without a slug

    // Parse key class-level fields:
    const scheduledStart = cs[0]; // e.g., "2023-01-15 10:00:00"
    const scheduledEnd = cs[1];   // e.g., "2023-01-15 11:00:00"
    const scheduledDuration = timestampDiff(cs[0], cs[1]); // in seconds
    const actualDuration = parseInt(cs[4], 10) * 60;
    const description = cs[9] || '';
    const subject = cs[11] || '';
    const level = cs[12] || '';
    const teacherSummary = cs[14] || '';
    const cancelledBy = cs[22] || '';    // Who cancelled this class (username or admin)
    const cancelledTime = cs[23] || '';  // When the class was cancelled (timestamp)

    // Build the base class object
    const cls = {
      scheduledStart,                      // Column 0
      scheduledDuration,                   // Computed from Column 0 & 1
      actualDuration,
      description,
      subject,
      level,
      teacherSummary,
      company: cs[5],                      // Column 5
      course_id: cs[29],                   // Column 29
      available_seats: parseInt(cs[10], 10), // Column 10
      cancelledBy,                         // Raw cancelledBy value (possibly username or empty)
      cancelledTime,                       // Raw cancelledTime string
      cancelledByStudent: false,           // Will set flags below
      cancelledByTeacher: false,
      cancelledByAdmin: false,
      cancelledInterval: '',               // Computed below (in hours, if cancelled)
      teacher: {},                         // Will populate if a teacher row exists
      students: []                         // Array of student objects (populated below)
    };

    cls.slug = slug;

    // 1. Gather participants rows for this class
    const participantsRows = participantsData.filter((p) => p[2] === slug);

    // 2. Separate enrolled students (column 9 indicates teacher if 'true')
    const enrolled = participantsRows.filter(
      (p) => !(p[9]?.trim().toLowerCase() === 'true')
    );

    // 3. Map each enrolled student row → student object
    cls.students = enrolled.map((pr) => {
      const enrolledAt = pr[22];      // Enrollment timestamp
      const studentCancelledTime = pr[14]; // Student cancellation timestamp

      return {
        username: pr[4],              // Column 4
        firstName: pr[5],   // Column 5
        lastName: pr[6],  
        attended: parseBoolean(pr[10]), // Column 10: 'true'/'false'
        tardiness: clampTardiness(
          timestampDiff(pr[3], pr[11]), // Column 3 (scheduledStart) vs Column 11 (actual join)
          scheduledDuration
        ),
        cancelled: parseBoolean(pr[12]), // Column 12 ('true' if student cancelled)
        cancelledBy: pr[13] || '',      // Column 13 indicates who cancelled (username)
        cancelledTime: studentCancelledTime, // Column 14
        cancelledInterval: studentCancelledTime
          ? (timestampDiff(studentCancelledTime, scheduledStart) / 3600).toFixed(2)
          : '',
        enrolledTime: enrolledAt, // Column 22
        enrolmentInterval: enrolledAt
          ? (timestampDiff(enrolledAt, scheduledStart) / 3600).toFixed(02)
          : '',
        rating: pr[15],   // Column 15: rating (string)
        feedback: pr[16]  // Column 16: feedback (string)
      };
    });

    // 4. Find the teacher row (column 9 === 'true')
    const teacherRow = participantsRows.find(
      (p) => p[9]?.trim().toLowerCase() === 'true'
    );
    if (teacherRow) {
      cls.teacher = {
        username: teacherRow[4], // Column 4
        firstName: teacherRow[5],     // Column 5
        lastName: teacherRow[6],
        attended: parseBoolean(teacherRow[10]), // Column 10
        tardiness: clampTardiness(
          timestampDiff(teacherRow[3], teacherRow[11]), // Scheduled vs actual join
          scheduledDuration
        ),
        cancelled: parseBoolean(teacherRow[12]) // Column 12
      };
    }

    // 5. Calculate cancellation flags and intervals
    const teacherName = cls.teacher?.username;
    const studentNames = cls.students.map((s) => s.username);

    if (cancelledBy) {
      cls.cancelledByStudent = studentNames.includes(cancelledBy);
      cls.cancelledByTeacher = cancelledBy === teacherName;
      cls.cancelledByAdmin = !cls.cancelledByStudent && !cls.cancelledByTeacher;
      cls.cancelledInterval = cancelledTime
        ? (timestampDiff(cancelledTime, scheduledStart) / 3600).toFixed(2)
        : '';
    }

    // 6. Add finalized class object to output map
    output[slug] = cls;
  });

  return output;
}


/* =============================================================================
   ======================= 3. REPORT BUILDING FUNCTIONS ========================
   =============================================================================
*/

/* -----------------------------------------------------------------------------
   3.1 Teacher Hour Count Report
   ----------------------------------------------------------------------------- */

/*
 * buildTeacherHourCountCSV
 * -------------------------
 * Builds a CSV string that reports, for each teacher, how many classes they taught
 * (group vs private), attended vs no-show, late arrivals, cancellations, etc.,
 * segmented by class duration buckets.
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @param {Object} settings - User-selected settings:
 *   - tardinessLimit: number (minutes) beyond which to penalize teacher tardiness
 *   - cancellationWindow: number (hours) used to detect "last-minute cancellations"
 *   - penaliseTardiness: boolean
 *   - payLastMinuteCancellation: boolean (counts a private student’s last-minute cancellation as "cancelled" class)
 *   - payStudentNoShow: boolean (deducts student no-shows from pay if studentNoShowRate applies)
 *   - studentNoShowRate: number (percentage, 0–100)
 *   - classTypeFilter: 'private' | 'group' | 'both'
 * @param {boolean} simpleReport - If true, output only the net-count column per duration; if false, include full breakdown.
 *
 * @returns {string} CSV-formatted string (headers + rows)
 */
function buildTeacherHourCountCSV(processedData, settings, simpleReport) {
  // Destructure settings for easier local variables
  const {
    tardinessLimit,
    cancellationWindow,
    penaliseTardiness,
    payLastMinuteCancellation,
    payStudentNoShow,
    studentNoShowRate,
    classTypeFilter
  } = settings;

  // Convert studentNoShowRate% → fraction if payment applies
  const studentNoShowFrac = payStudentNoShow ? studentNoShowRate / 100 : 0;

  // Structure to accumulate per-teacher, per-duration buckets
  const teacherReports = {};
  const durationsSet = new Set();

  // 1) Aggregate per-class data into teacherReports
  Object.keys(processedData).forEach((slug) => {
    const cls = processedData[slug];
    const durationMin = Math.round(cls.scheduledDuration / 60);
    durationsSet.add(durationMin);

    const teacherName = cls.teacher.username;
    if (!teacherName) return; // Skip classes without a teacher

    // Determine class type (private if available_seats === 1; otherwise group)
    const type = cls.available_seats === 1 ? 'private' : 'group';
    if (classTypeFilter !== 'both' && classTypeFilter !== type) {
      return; // Skip if our filter excludes this type
    }

    // Initialize teacher entry if needed
    teacherReports[teacherName] = teacherReports[teacherName] || { durations: {} };
    const durationBuckets = teacherReports[teacherName].durations;

    // Initialize duration bucket if needed
    if (!durationBuckets[durationMin]) {
      durationBuckets[durationMin] = {
        private: { attended: 0, noShow: 0, cancelled: 0, late: 0, studentNoShow: 0 },
        group:   { attended: 0, noShow: 0,               late: 0, studentNoShow: 0 }
      };
    }
    const bucket = durationBuckets[durationMin][type];

    // Flags for teacher attendance/cancellation
    const teacherAttended = Boolean(cls.teacher.attended);
    const teacherCancelled = Boolean(cls.teacher.cancelled);
    const teacherTardinessMin = Math.round(cls.teacher.tardiness / 60);

    // 1a) Count last-minute student cancellations for private classes if settings specify
    if (type === 'private' && payLastMinuteCancellation && Array.isArray(cls.students)) {
      cls.students.forEach((student) => {
        if (student.cancelled && student.cancelledBy !== teacherName) {
          // If the student cancelled within cancellationWindow hours before class start,
          // we count that as a "cancelled" slot paid to teacher
          const diffHr = timestampDiff(cls.scheduledStart, student.cancelledTime) / 3600;
          if (diffHr < cancellationWindow) {
            bucket.cancelled++;
            // Only count the first such “late” student cancellation per class
            return;
          }
        }
      });
    }

    // 1b) Teacher attendance vs no-show vs late
    if (teacherAttended) {
      bucket.attended++;
      if (penaliseTardiness && teacherTardinessMin > tardinessLimit) {
        bucket.late++;
      }
    } else {
      bucket.noShow++;
    }

    // 1c) Student no-show case:
    // - Teacher attended AND not cancelled AND all students did not attend
    if (
      teacherAttended &&
      !teacherCancelled &&
      Array.isArray(cls.students) &&
      cls.students.length > 0 &&
      cls.students.every((s) => !s.attended)
    ) {
      bucket.studentNoShow++;
    }
  });

  // 2) Build CSV header row
  const durations = Array.from(durationsSet).sort((a, b) => a - b);
  const header = ['teacher'];

  /*
   * Helper: push columns for a given class type ('private' or 'group') into the header.
   * If simpleReport is true, only push the final "count" column per duration.
   * Otherwise, push detailed columns (attended, cancelled (<window>h), noShow, studentNoShow, late, netCount).
   */
  function makeCols(type) {
    durations.forEach((d) => {
      if (simpleReport) {
        header.push(`${d}min ${type} classes count`);
      } else {
        header.push(`${d}min ${type} classes attended`);
        if (type === 'private') {
          header.push(`${d}min ${type} classes cancelled < ${cancellationWindow}h`);
        }
        header.push(`${d}min ${type} classes no show`);
        header.push(`${d}min ${type} student no show`);
        header.push(`${d}min ${type} classes late`);
        header.push(`${d}min ${type} classes count`);
      }
    });
    // Add total count and total minutes columns for this type
    header.push(`Total ${type} classes count`);
    header.push(`Total ${type} minutes`);
  }

  // Build columns for private and/or group depending on filter
  if (classTypeFilter === 'both') {
    makeCols('private');
    makeCols('group');
  } else {
    makeCols(classTypeFilter);
  }

  // 3) Build data rows for each teacher
  const rows = [header.join(',')];

  Object.keys(teacherReports).forEach((teacher) => {
    const durationBuckets = teacherReports[teacher].durations;
    const row = [teacher];

    let totalPrivCount = 0;
    let totalPrivMin = 0;
    let totalGrpCount = 0;
    let totalGrpMin = 0;

    /*
     * Helper: push aggregated values for a given class type into the row.
     * Calculates netCount = attended - (late? penalise) + (cancelled if last-minute) - (studentNoShow * (1 - studentNoShowFrac)).
     */
    function pushType(type) {
      durations.forEach((d) => {
        const bucket = (durationBuckets[d] && durationBuckets[d][type]) || {
          attended: 0,
          cancelled: 0,
          noShow: 0,
          late: 0,
          studentNoShow: 0
        };

        // Base count before deductions/additions
        let baseCount = bucket.attended;
        if (penaliseTardiness) {
          baseCount -= bucket.late;
        }
        if (type === 'private' && payLastMinuteCancellation) {
          baseCount += bucket.cancelled;
        }

        // Deduct student no-shows (with a fraction if payStudentNoShow is true)
        const deduction = bucket.studentNoShow * (1 - studentNoShowFrac);
        const netCount = parseFloat((baseCount - deduction).toFixed(2));

        if (simpleReport) {
          row.push(netCount);
        } else {
          row.push(bucket.attended);
          if (type === 'private') row.push(bucket.cancelled);
          row.push(bucket.noShow);
          row.push(bucket.studentNoShow);
          row.push(bucket.late);
          row.push(netCount);
        }

        if (type === 'private') {
          totalPrivCount += netCount;
          totalPrivMin += netCount * d;
        } else {
          totalGrpCount += netCount;
          totalGrpMin += netCount * d;
        }
      });

      // Append totals for this type
      if (type === 'private') {
        row.push(totalPrivCount, totalPrivMin);
      } else {
        row.push(totalGrpCount, totalGrpMin);
      }
    }

    if (classTypeFilter === 'both') {
      pushType('private');
      pushType('group');
    } else {
      pushType(classTypeFilter);
    }

    rows.push(row.join(','));
  });

  return rows.join('\n');
}


/* -----------------------------------------------------------------------------
   3.2 Teacher Overview & Feedback Report
   ----------------------------------------------------------------------------- */

/*
 * buildTeacherOverviewCSV
 * ------------------------
 * For each teacher, aggregates:
 *   - total group classes, total private classes
 *   - number attended vs noShow vs nonCancelled
 *   - cancellations by teacher vs by student
 *   - total/average tardiness
 *   - average rating (across all students)
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @returns {string} CSV string with header + one row per teacher
 */
/**
 * Builds CSV for private-class metrics per teacher.
 */
function buildTeacherPrivateClassesCSV(processedData) {
  const stats = {};

  Object.values(processedData).forEach((cls) => {
    if (cls.available_seats !== 1) return; // skip non-private
    const name = cls.teacher.username;
    if (!name) return;

    if (!stats[name]) {
      stats[name] = {
        totalBooked: 0,
        cancelledByTeacher: 0,
        cancelledByAdmin: 0,
        cancelledByStudent: 0,
        totalRemaining: 0,
        teacherNoShows: 0,
        studentNoShows: 0,
        teacherTardinessSum: 0,
        teacherTardinessCount: 0,
        studentTardinessSum: 0,
        studentTardinessCount: 0,
        ratingSum: 0,
        ratingCount: 0,
        feedbackCount: 0
      };
    }
    const s = stats[name];
    s.totalBooked++;

    // cancellations
    if (cls.cancelledByTeacher) s.cancelledByTeacher++;
    else if (cls.cancelledByStudent) s.cancelledByStudent++;
    else if (cls.cancelledByAdmin)   s.cancelledByAdmin++;

    // remaining & no-shows
    if (!cls.cancelledBy) {
      s.totalRemaining++;
      if (!cls.teacher.attended) s.teacherNoShows++;
      const allAbsent = cls.students.every((st) => !st.attended);
      if (cls.teacher.attended && allAbsent) s.studentNoShows++;
    }

    // teacher tardiness
    const tMin = cls.teacher.tardiness / 60;
    s.teacherTardinessSum += tMin;
    s.teacherTardinessCount++;

    // students: tardiness, ratings, feedback
    cls.students.forEach((st) => {
      if (typeof st.tardiness === 'number') {
        s.studentTardinessSum += st.tardiness / 60;
        s.studentTardinessCount++;
      }
      const r = parseFloat(st.rating);
      const hasFB = (st.feedback && st.feedback.trim()) || !isNaN(r);
      if (!isNaN(r)) {
        s.ratingSum += r;
        s.ratingCount++;
      }
      if (hasFB) s.feedbackCount++;
    });
  });

  // build CSV
  const header = [
    'teacher',
    'total classes booked',
    'cancelled by teacher',
    'cancelled by admin',
    'cancelled by student',
    'total remaining classes',
    'teacher no shows',
    'student no shows',
    'average teacher tardiness',
    'average student tardiness',
    'average rating',
    'feedback rate'
  ];
  const rows = [header.join(',')];

  Object.entries(stats).forEach(([name, s]) => {
    const avgTardT = s.teacherTardinessCount
      ? (s.teacherTardinessSum / s.teacherTardinessCount).toFixed(2)
      : '0.00';
    const avgTardS = s.studentTardinessCount
      ? (s.studentTardinessSum / s.studentTardinessCount).toFixed(2)
      : '0.00';
    const avgRating = s.ratingCount
      ? (s.ratingSum / s.ratingCount).toFixed(2)
      : '0.00';
    const fbRate = s.totalBooked
      ? ((s.feedbackCount / s.totalBooked) * 100).toFixed(2)
      : '0.00';

    rows.push([
      `"${name}"`,
      s.totalBooked,
      s.cancelledByTeacher,
      s.cancelledByAdmin,
      s.cancelledByStudent,
      s.totalRemaining,
      s.teacherNoShows,
      s.studentNoShows,
      avgTardT,
      avgTardS,
      avgRating,
      fbRate
    ].join(','));
  });

  return rows.join('\n');
}

/**
 * Builds CSV for group-class metrics per teacher.
 */
function buildTeacherGroupClassesCSV(processedData) {
  const stats = {};

  Object.values(processedData).forEach((cls) => {
    if (cls.available_seats <= 1) return; // skip private
    const name = cls.teacher.username;
    if (!name) return;

    if (!stats[name]) {
      stats[name] = {
        totalBooked: 0,
        cancelledByTeacher: 0,
        cancelledByAdmin: 0,
        totalRemaining: 0,
        teacherNoShows: 0,
        classStudentNoShowClasses: 0,
        classStudentNoShowTotal: 0,
        teacherTardinessSum: 0,
        teacherTardinessCount: 0,
        studentTardinessSum: 0,
        studentTardinessCount: 0,
        ratingSum: 0,
        ratingCount: 0,
        feedbackClassCount: 0
      };
    }
    const s = stats[name];
    s.totalBooked++;

    if (cls.cancelledByTeacher) s.cancelledByTeacher++;
    else if (cls.cancelledByAdmin)    s.cancelledByAdmin++;

    if (!cls.cancelledBy) {
      s.totalRemaining++;
      if (!cls.teacher.attended) s.teacherNoShows++;
      const anyNoShow = cls.students.some((st) => !st.attended && !st.cancelled);
      if (anyNoShow) s.classStudentNoShowClasses++;
    }

    // total student no-shows
    const noShowCount = cls.students.filter((st) => !st.attended && !st.cancelled).length;
    s.classStudentNoShowTotal += noShowCount;

    // teacher tardiness
    const tMin = cls.teacher.tardiness / 60;
    s.teacherTardinessSum += tMin;
    s.teacherTardinessCount++;

    cls.students.forEach((st) => {
      if (typeof st.tardiness === 'number') {
        s.studentTardinessSum += st.tardiness / 60;
        s.studentTardinessCount++;
      }
      const r = parseFloat(st.rating);
      const hasFB = (st.feedback && st.feedback.trim()) || !isNaN(r);
      if (!isNaN(r)) {
        s.ratingSum += r;
        s.ratingCount++;
      }
      if (hasFB) s.feedbackClassCount++;
    });
  });

  // build CSV
  const header = [
    'teacher',
    'total classes booked',
    'cancelled by teacher',
    'cancelled by admin',
    'total remaining classes',
    'teacher no shows',
    'student no shows (classes)',
    'student no shows (total)',
    'average teacher tardiness',
    'average student tardiness',
    'average rating',
    'feedback rate'
  ];
  const rows = [header.join(',')];

  Object.entries(stats).forEach(([name, s]) => {
    const avgTardT = s.teacherTardinessCount
      ? (s.teacherTardinessSum / s.teacherTardinessCount).toFixed(2)
      : '0.00';
    const avgTardS = s.studentTardinessCount
      ? (s.studentTardinessSum / s.studentTardinessCount).toFixed(2)
      : '0.00';
    const avgRating = s.ratingCount
      ? (s.ratingSum / s.ratingCount).toFixed(2)
      : '0.00';
    const fbRate = s.totalBooked
      ? ((s.feedbackClassCount / s.totalBooked) * 100).toFixed(2)
      : '0.00';

    rows.push([
      `"${name}"`,
      s.totalBooked,
      s.cancelledByTeacher,
      s.cancelledByAdmin,
      s.totalRemaining,
      s.teacherNoShows,
      s.classStudentNoShowClasses,
      s.classStudentNoShowTotal,
      avgTardT,
      avgTardS,
      avgRating,
      fbRate
    ].join(','));
  });

  return rows.join('\n');
}

/*
 * buildTeacherFeedbackCSV
 * ------------------------
 * Produces a CSV of individual feedback entries per teacher per student:
 * Columns: teacher, student, class date, feedback, rating
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @returns {string} CSV string with header + one row per feedback entry
 */
function buildTeacherFeedbackCSV(processedData) {
  const rows = ['teacher,student,class date,feedback,rating'];

  Object.keys(processedData).forEach((classSlug) => {
    const cls = processedData[classSlug];
    const teacherUsername = cls.teacher.username;
    if (!teacherUsername) return;

    const classDate = cls.scheduledStart; // e.g., "2023-01-15 10:00:00"

    cls.students.forEach((student) => {
      const feedback = (student.feedback || '').trim();
      const rating = (student.rating || '').trim();

      // Only include if there is a non-empty feedback or rating
      if (feedback || rating) {
        // Wrap feedback in quotes to handle commas inside
        rows.push([
          teacherUsername,
          student.username,
          classDate,
          `"${feedback}"`,
          rating
        ].join(','));
      }
    });
  });

  return rows.join('\n');
}


/* -----------------------------------------------------------------------------
   3.3 Course Reports
   ----------------------------------------------------------------------------- */

/*
 * buildAllCoursesOverviewCSV
 * ---------------------------
 * Summarizes courses by aggregating all classes with the same course ID. For each
 * course ID, reports:
 *   - teacher(s) involved
 *   - first class date, last class date
 *   - level, subject, course description (from the first class's metadata)
 *   - total number of classes, available seats
 *   - number of unique students enrolled
 *   - overall attendance rate across all students & all classes
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @returns {string} CSV string with header + one row per course ID
 */
function buildAllCoursesOverviewCSV(processedData) {
  // 1) Group classes by course ID
  const byCourse = {};
  Object.keys(processedData).forEach((slug) => {
    const cls = processedData[slug];
    const courseId = cls['course_id'] || 'NO_ID';
    byCourse[courseId] = byCourse[courseId] || [];
    byCourse[courseId].push(cls);
  });

  // 2) Build header
  const header = [
    'course ID',
    'teacher',
    'start date',
    'end date',
    'level',
    'subject',
    'course description',
    'total classes',
    'seats',
    'students enrolled (unique)',
    'attendance rate (%)'
  ];
  const rows = [header.join(',')];

  // 3) For each course ID, compute aggregates
  Object.keys(byCourse).forEach((courseId) => {
    const classes = byCourse[courseId].sort(
      (a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart)
    );
    const firstClass = classes[0];
    const teachers = unique(classes.map((c) => c.teacher.username).filter(Boolean));

    let allStudentUsernames = [];
    let attendedCount = 0;
    let totalStudentParticipations = 0;

    classes.forEach((cls) => {
      if (!Array.isArray(cls.students)) return;
      cls.students.forEach((student) => {
        allStudentUsernames.push(student.username);
        totalStudentParticipations++;
        if (student.attended) attendedCount++;
      });
    });

    const uniqueStudents = unique(allStudentUsernames);
    const classCount = classes.length;
    const attendanceRate = totalStudentParticipations
      ? Math.round((attendedCount / totalStudentParticipations) * 100)
      : '';

    rows.push([
      `"${courseId}"`,
      `"${teachers.join(' - ')}"`,
      `"${classes[0].scheduledStart}"`,
      `"${classes[classes.length - 1].scheduledStart}"`,
      `"${firstClass.level || ''}"`,
      `"${firstClass.subject || ''}"`,
      `"${firstClass['course description'] || ''}"`,
      classCount,
      `"${firstClass.available_seats || ''}"`,
      uniqueStudents.length,
      attendanceRate
    ].join(','));
  });

  return rows.join('\n');
}

/*
 * buildCourseDetailReport
 * ------------------------
 * For a specific course ID, produces two CSV strings:
 *   - infoCsv: high-level info about course (ID, teachers, first/last date, etc.)
 *   - classListCsv: one row per class with each student's status (attended / cancelled / no show)
 *
 * Also returns uniqueStudents array for possible further UI use.
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @param {string} courseId - The course ID to filter by
 * @returns {Object} { infoCsv: string, classListCsv: string, uniqueStudents: Array<string> }
 */
function buildCourseDetailReport(processedData, courseId) {
  // Filter classes belonging to this course ID
  const classes = Object.values(processedData)
    .filter((cls) => (cls.course_id || 'NO_ID') === courseId)
    .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));

  if (!classes.length) {
    return { infoCsv: '', classListCsv: '', uniqueStudents: [] };
  }

  const teachers = unique(classes.map((cls) => cls.teacher.username).filter(Boolean));
  let allStudentUsernames = [];
  let attendedCount = 0;
  let totalStudentParticipations = 0;

  classes.forEach((cls) => {
    if (!Array.isArray(cls.students)) return;
    cls.students.forEach((student) => {
      allStudentUsernames.push(student.username);
      totalStudentParticipations++;
      if (student.attended) attendedCount++;
    });
  });

  const uniqueStudents = unique(allStudentUsernames);
  const attendanceRate = totalStudentParticipations
    ? Math.round((attendedCount / totalStudentParticipations) * 100)
    : '';

  // Build the infoCsv header & single row
  const infoHeader = [
    'course ID',
    'teacher(s)',
    'start date',
    'end date',
    'level',
    'subject',
    'course description',
    'seats',
    'students enrolled',
    'total classes',
    'attendance rate (%)'
  ];
  const firstClass = classes[0];
  const infoRow = [
    `"${courseId}"`,
    `"${teachers.join(' - ')}"`,
    `"${classes[0].scheduledStart}"`,
    `"${classes[classes.length - 1].scheduledStart}"`,
    `"${firstClass.level || ''}"`,
    `"${firstClass.subject || ''}"`,
    `"${firstClass['course description'] || ''}"`,
    `"${firstClass.available_seats || ''}"`,
    uniqueStudents.length,
    classes.length,
    attendanceRate
  ];

  // Build the classListCsv
  const classListHeader = [
    'class number',
    'date',
    'time',
    'duration',
    'status',
    ...uniqueStudents.map((u) => `"${u}"`)
  ];
  const classListRows = [classListHeader.join(',')];

  classes.forEach((cls, idx) => {
    const dtObj = new Date(cls.scheduledStart.replace(' ', 'T'));
    const date = dtObj.toLocaleDateString();
    const time = dtObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const hours = Math.floor((cls.scheduledDuration || 0) / 60)
      .toString()
      .padStart(2, '0');
    const mins = ((cls.scheduledDuration || 0) % 60).toString().padStart(2, '0');
    const duration = `${hours}:${mins}`;
    const status = cls.cancelledBy ? 'cancelled' : 'completed';

    // For each unique student, find their status in this class
    const rowByStudent = uniqueStudents.map((username) => {
      const studentObj = Array.isArray(cls.students)
        ? cls.students.find((s) => s.username === username)
        : undefined;
      if (!studentObj) return '';
      if (studentObj.cancelled) return 'cancelled';
      if (studentObj.attended) return 'attended';
      return 'no show';
    });

    classListRows.push([
      `Class ${idx + 1}`,
      date,
      time,
      duration,
      status,
      ...rowByStudent
    ].join(','));
  });

  return {
    infoCsv: [infoHeader.join(','), infoRow.join(',')].join('\n'),
    classListCsv: classListRows.join('\n'),
    uniqueStudents
  };
}

/**
 * Builds a CSV for each student’s overview stats in a particular course.
 */
function buildCourseStudentOverviewCSV(processedData, courseId) {
  // 1. Get all classes for this course
  const classes = Object.values(processedData)
    .filter((cls) => (cls.course_id || 'NO_ID') === courseId);

  // 2. Tally per‐student stats
  const stats = {}; // username → { enrolled, attended, noShow, cancelled }
  classes.forEach((cls) => {
    (cls.students || []).forEach((s) => {
      const u = s.username;
      if (!stats[u]) {
        stats[u] = { enrolled: 0, attended: 0, noShow: 0, cancelled: 0 };
      }
      stats[u].enrolled += 1;
      if (s.attended) {
        stats[u].attended += 1;
      } else if (s.cancelled) {
        stats[u].cancelled += 1;
      } else {
        stats[u].noShow += 1;
      }
    });
  });

  // 3. Build CSV lines
  const header = ['username', 'enrolled', 'attended', 'no_show', 'cancelled', 'attendance_rate'];
  const rows = [header.join(',')];

  Object.keys(stats).forEach((u) => {
    const { enrolled, attended, noShow, cancelled } = stats[u];
    const rate = ((attended / enrolled) * 100).toFixed(2) + '%';
    // wrap username in quotes in case it contains commas
    rows.push([`"${u}"`, enrolled, attended, noShow, cancelled, rate].join(','));
  });

  return rows.join('\n');
}


/* -----------------------------------------------------------------------------
   3.4 Student Report
   ----------------------------------------------------------------------------- */

/*
 * buildStudentReport
 * -------------------
 * Builds a per-student CSV report based on processedData and filters. Aggregates,
 * for each student:
 *   - total group/private classes
 *   - number attended, no-show, cancellations (and late cancellations)
 *   - average cancellation interval (hrs), average tardiness (min)
 *   - average rating, average enrolment interval (hrs)
 *   - average class interval (hrs)
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @param {Object} options - Must include:
 *   - cancellationWindow: number (hours)
 *   - companyId: string ('ALL' or specific company)
 *   - filterMode: 'all' | 'company' | 'custom'
 *   - customList: Array<string> of valid usernames to include (if filterMode === 'custom')
 * @returns {string} CSV string with header + one row per student
 */
function buildStudentReport(processedData, options) {
  const { cancellationWindow, companyId, filterMode, customList } = options;

  // Map of username → student aggregate object
  const students = {};

  Object.keys(processedData).forEach((slug) => {
    const cls = processedData[slug];

    // --- FILTER CLASSES ACCORDING TO filterMode ---
    if (filterMode === 'company' && companyId !== 'ALL' && String(cls.company) !== String(companyId)) {
      return;
    }
    // filterMode 'all' or 'custom' → no class-level filter here

    const scheduledStartD = new Date(cls.scheduledStart.replace(' ', 'T'));
    const seats = cls.available_seats;

    // For each student in this class, accumulate stats if they pass student filter
    cls.students.forEach((student) => {
      const username = student.username;
      if (!username) return;

      // --- FILTER STUDENTS ACCORDING TO filterMode ---
      if (filterMode === 'custom' && !customList.includes(username)) {
        return;
      }
      // 'all' & 'company' → all students in included classes are fine

      // Initialize aggregate object if first time seeing this student
      if (!students[username]) {
        students[username] = {
          username,
          company: cls.company,
          totalGroup: 0,
          totalPrivate: 0,
          attended: 0,
          noShow: 0,
          cancelled: 0,
          cancelledLate: 0,
          cancellationIntervals: [],
          ratingSum: 0,
          ratingCount: 0,
          enrolmentIntervals: [],
          tardinessSum: 0,
          tardinessCount: 0,
          classDates: []
        };
      }

      const s = students[username];
      // PRIVATE vs GROUP
      if (seats === 1) {
        s.totalPrivate++;
      } else {
        s.totalGroup++;
      }

      s.classDates.push(scheduledStartD);

      // ATTENDANCE / CANCELLATION
      if (student.cancelled) {
        // Count all cancellations
        s.cancelled++;
        if (student.cancelledTime) {
          const cancelledD = new Date(student.cancelledTime.replace(' ', 'T'));
          const diffHr = (scheduledStartD - cancelledD) / 3600e3; // hours difference
          s.cancellationIntervals.push(diffHr);
          if (diffHr < cancellationWindow) {
            s.cancelledLate++;
          }
        }
      } else if (student.attended) {
        // Student did attend
        s.attended++;
      } else {
        // Student did not attend and did not explicitly cancel → no-show
        s.noShow++;
      }

      // ENROLMENT INTERVAL
      if (student.enrolledTime) {
        const enrD = new Date(student.enrolledTime.replace(' ', 'T'));
        const diffHr = (scheduledStartD - enrD) / 3600e3;
        s.enrolmentIntervals.push(diffHr);
      }

      // TARDINESS (store minutes)
      if (typeof student.tardiness === 'number') {
        s.tardinessSum += student.tardiness / 60;
        s.tardinessCount++;
      }

      // RATING
      const r = parseFloat(student.rating);
      if (!isNaN(r)) {
        s.ratingSum += r;
        s.ratingCount++;
      }
    });
  });

  // Build CSV header
  const header = [
    'student',
    'company',
    'total group classes',
    'total private classes',
    'attendance rate',
    'no show rate',
    'cancellation rate',
    'late cancellation rate',
    'average cancellation interval (hrs)',
    'average tardiness (min)',
    'average rating',
    'average enrolment interval (hrs)',
    'average class interval (hrs)'
  ].join(',');
  const rows = [header];

  // Populate one row per student
  Object.values(students).forEach((s) => {
    const totalClasses = s.totalGroup + s.totalPrivate;
    const attRate = totalClasses ? (s.attended / totalClasses).toFixed(2) : '';
    const noShowRate = totalClasses ? (s.noShow / totalClasses).toFixed(2) : '';
    const cancelRate = totalClasses ? (s.cancelled / totalClasses).toFixed(2) : '';
    const lateCancelRate = totalClasses ? (s.cancelledLate / totalClasses).toFixed(2) : '';

    const avgCancelInt = s.cancellationIntervals.length
      ? (s.cancellationIntervals.reduce((a, b) => a + b, 0) / s.cancellationIntervals.length).toFixed(2)
      : '';

    const avgTard = s.tardinessCount
      ? (s.tardinessSum / s.tardinessCount).toFixed(2)
      : '';

    const avgRating = s.ratingCount
      ? (s.ratingSum / s.ratingCount).toFixed(2)
      : '';

    const avgEnrol = s.enrolmentIntervals.length
      ? (s.enrolmentIntervals.reduce((a, b) => a + b, 0) / s.enrolmentIntervals.length).toFixed(2)
      : '';

    // Calculate average interval between classes (only for students with multiple classes)
    let avgClassInt = '';
    if (s.classDates.length > 1) {
      const sortedDates = s.classDates.sort((a, b) => a - b);
      let sumDiffHr = 0;
      for (let i = 1; i < sortedDates.length; i++) {
        sumDiffHr += (sortedDates[i] - sortedDates[i - 1]) / 3600e3;
      }
      avgClassInt = (sumDiffHr / (sortedDates.length - 1)).toFixed(2);
    }

    rows.push([
      s.username,
      s.company,
      s.totalGroup,
      s.totalPrivate,
      attRate,
      noShowRate,
      cancelRate,
      lateCancelRate,
      avgCancelInt,
      avgTard,
      avgRating,
      avgEnrol,
      avgClassInt
    ].join(','));
  });

  return rows.join('\n');
}


/* -----------------------------------------------------------------------------
   3.5 Overview Data & Private Averages Table (HTML)
   ----------------------------------------------------------------------------- */

/*
 * buildOverviewData
 * ------------------
 * Creates aggregated statistics for all classes, broken out by class type (private vs group)
 * and by duration. Returns two objects: groupData and privateData, each mapping:
 *   duration (minutes) → { total, completed, cancelled, cancelledByStudent, cancelledByTeacher, cancelledByAdmin, studentCancelledLate, teacherNoShow, studentNoShow, bothNoShow }
 *
 * @param {Object<string, Object>} processedData - Output from processData()
 * @param {number} cancellationWindow - Hours within which a student cancellation is "late"
 * @returns {Object} { groupData: Object, privateData: Object }
 */
function buildOverviewData(processedData, cancellationWindow) {
  /*
   * tally
   * -----
   * Helper to compute the bucketed stats for a given class type.
   *
   * @param {string} type - 'private' or 'group'
   * @returns {Object<number, Object>} Map: duration (minutes) → metrics object
   */
  function tally(type) {
    const byDuration = {};

    Object.values(processedData)
      .filter((cls) => (type === 'private' ? cls.available_seats === 1 : cls.available_seats > 1))
      .forEach((cls) => {
        const d = Math.round(cls.scheduledDuration / 60);
        if (!byDuration[d]) {
          byDuration[d] = {
            total: 0,
            completed: 0,
            cancelled: 0,
            cancelledByStudent: 0,
            cancelledByTeacher: 0,
            cancelledByAdmin: 0,
            studentCancelledLate: 0,
            teacherNoShow: 0,
            studentNoShow: 0,
            bothNoShow: 0
          };
        }
        const bucket = byDuration[d];
        bucket.total++;

        const teacherAttended = cls.teacher.attended;
        const classCancelled = Boolean(cls.cancelledBy);

        // Completed = teacher attended & class not cancelled
        if (teacherAttended && !classCancelled) {
          bucket.completed++;
        }

        // Any cancellation → classify
        if (classCancelled) {
          bucket.cancelled++;
          if (cls.cancelledByStudent) bucket.cancelledByStudent++;
          if (cls.cancelledByTeacher) bucket.cancelledByTeacher++;
          if (cls.cancelledByAdmin) bucket.cancelledByAdmin++;

          // Late student cancellation?
          if (
            cls.cancelledByStudent &&
            cls.cancelledInterval !== '' &&
            parseFloat(cls.cancelledInterval) < cancellationWindow
          ) {
            bucket.studentCancelledLate++;
          }
        }

        // Teacher no-show (teacher didn't attend & class not cancelled)
        if (!teacherAttended && !classCancelled) {
          bucket.teacherNoShow++;
        }

        // Student no-show: group vs private differ slightly:
        const allStudentsAbsent =
          Array.isArray(cls.students) &&
          cls.students.length > 0 &&
          cls.students.every((s) => !s.attended);

        if (type === 'group') {
          if (allStudentsAbsent) {
            bucket.studentNoShow++;
          }
        } else {
          // private: teacher attended & allStudentsAbsent → student no-show
          if (teacherAttended && allStudentsAbsent) {
            bucket.studentNoShow++;
          }
        }

        // Both no-show: teacher no-show & all students absent
        if (!teacherAttended && !classCancelled && allStudentsAbsent) {
          bucket.bothNoShow++;
        }
      });

    return byDuration;
  }

  const groupData = tally('group');
  const privateData = tally('private');
  return { groupData, privateData };
}

/*
 * buildPrivateAveragesTable
 * --------------------------
 * Builds an HTML <table> that compares average metrics across all private classes
 * for both students and teachers. Metrics include:
 *   - total classes, attended, cancelled (by student, teacher, admin)
 *   - average cancellation interval, average tardiness, average enrolment interval, average class interval, etc.
 *
 * @param {Object<string, Object>} data - processedData from processData()
 * @returns {string} HTML string representing the table
 */
function buildPrivateAveragesTable(data) {
  const studentStats = {};
  const teacherStats = {};

  // 1) Accumulate stats across all private classes
  Object.values(data).forEach((cls) => {
    if (cls.available_seats !== 1) return; // Only private classes

    const teacher = cls.teacher.username;
    const teacherAttended = cls.teacher.attended;

    // Initialize teacherStats if first time
    if (teacher) {
      teacherStats[teacher] = teacherStats[teacher] || {
        total: 0,
        attended: 0,
        cancelled: 0,
        cancelledByTeacher: 0,
        cancelledByStudent: 0,
        cancelledByAdmin: 0,
        cancelledIntervalSum: 0,
        cancelledIntervalCount: 0,
        teacherNoShow: 0,
        studentNoShow: 0,
        tardinessSum: 0,
        tardinessCount: 0,
        classDates: []
      };
      const t = teacherStats[teacher];
      t.total++;
      if (teacherAttended) t.attended++;
      if (cls.teacher.cancelled) t.teacherNoShow++;
      if (cls.cancelledBy) t.cancelled++;
      if (cls.cancelledByTeacher) t.cancelledByTeacher++;
      if (cls.cancelledByStudent) t.cancelledByStudent++;
      if (cls.cancelledByAdmin) t.cancelledByAdmin++;
      if (cls.cancelledInterval !== '') {
        t.cancelledIntervalSum += parseFloat(cls.cancelledInterval);
        t.cancelledIntervalCount++;
      }
      if (typeof cls.teacher.tardiness === 'number') {
        t.tardinessSum += cls.teacher.tardiness / 60;
        t.tardinessCount++;
      }

      // Count if all students absent → student no-show for teacher
      const allStudentsAbsent =
        cls.students.length > 0 && cls.students.every((s) => !s.attended);
      if (allStudentsAbsent) t.studentNoShow++;

      t.classDates.push(new Date(cls.scheduledStart.replace(' ', 'T')));
    }

    // Accumulate stats per student in this private class
    cls.students.forEach((student) => {
      const username = student.username;
      if (!username) return;
      studentStats[username] = studentStats[username] || {
        total: 0,
        attended: 0,
        cancelled: 0,
        cancelledByStudent: 0,
        cancelledByTeacher: 0,
        cancelledByAdmin: 0,
        cancelledIntervalSum: 0,
        cancelledIntervalCount: 0,
        enrolIntervalSum: 0,
        enrolIntervalCount: 0,
        tardinessSum: 0,
        tardinessCount: 0,
        studentNoShow: 0,
        teacherNoShow: 0,
        classDates: []
      };
      const s = studentStats[username];
      s.total++;
      if (student.attended) s.attended++;
      else s.studentNoShow++;
      if (!teacherAttended) s.teacherNoShow++;
      if (student.cancelled) {
        s.cancelled++;
        if (student.cancelledBy === username) s.cancelledByStudent++;
        else if (student.cancelledBy === teacher) s.cancelledByTeacher++;
        else if (student.cancelledBy) s.cancelledByAdmin++;
        if (!isNaN(parseFloat(student.cancelledInterval))) {
          s.cancelledIntervalSum += parseFloat(student.cancelledInterval);
          s.cancelledIntervalCount++;
        }
      }
      if (!isNaN(parseFloat(student.enrolmentInterval))) {
        s.enrolIntervalSum += parseFloat(student.enrolmentInterval);
        s.enrolIntervalCount++;
      }
      if (typeof student.tardiness === 'number') {
        s.tardinessSum += student.tardiness / 60;
        s.tardinessCount++;
      }
      s.classDates.push(new Date(cls.scheduledStart.replace(' ', 'T')));
    });
  });


  
  /*
   * calcAvg
   * -------
   * Given a map of stats, calculates average metrics across all keys.
   *
   * @param {Object<string, Object>} statsMap - Map: key (username) → stats object
   * @returns {Object<string, string>} Map: metric label → average value (string with 2 decimals)
   */
  function calcAvg(statsMap) {
    const values = Object.values(statsMap);
    const avg = (key) =>
      values.length
        ? (values.reduce((sum, v) => sum + (v[key] || 0), 0) / values.length).toFixed(2)
        : '0.00';

    const avgDiv = (numKey, denomKey) =>
      values.length
        ? (
            values.reduce((sum, v) => {
              if (!v[denomKey]) return sum;
              return sum + v[numKey] / v[denomKey];
            }, 0) / values.length
          ).toFixed(2)
        : '0.00';

    const avgClassInterval = values.length
      ? (
          values.reduce((acc, stats) => {
            const dates = stats.classDates.sort((a, b) => a - b);
            if (dates.length < 2) return acc;
            let sumInterval = 0;
            for (let i = 1; i < dates.length; i++) {
              sumInterval += (dates[i] - dates[i - 1]) / (1000 * 3600);
            }
            return acc + sumInterval / (dates.length - 1);
          }, 0) / values.length
        ).toFixed(2)
      : '0.00';

    return {
      'Average Classes': avg('total'),
      'Average Attended Classes': avg('attended'),
      'Average Cancellations (Total)': avg('cancelled'),
      'Average Cancellations by Student': avg('cancelledByStudent'),
      'Average Cancellations by Teacher': avg('cancelledByTeacher'),
      'Average Cancellations by Admin': avg('cancelledByAdmin'),
      'Average Cancellation Interval (hours)': avgDiv('cancelledIntervalSum', 'cancelledIntervalCount'),
      'Average Teacher No Shows': avg('teacherNoShow'),
      'Average Student No Shows': avg('studentNoShow'),
      'Average Tardinesss (min)': avgDiv('tardinessSum', 'tardinessCount'),
      'Average Enrolment Interval (hours)': avgDiv('enrolIntervalSum', 'enrolIntervalCount'),
      'Average Class Interval (hours)': avgClassInterval
    };
  }

  const studentRow = calcAvg(studentStats);
  const teacherRow = calcAvg(teacherStats);

  // Build HTML table
  const labels = Object.keys(studentRow);
  let html = '<table><thead><tr><th>Metric</th><th>Students</th><th>Teachers</th></tr></thead><tbody>';
  labels.forEach((label) => {
    html += `<tr>
      <th>${label}</th>
      <td>${studentRow[label]}</td>
      <td>${teacherRow[label]}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}


/* =============================================================================
   ====================== 4. UI STATE & EVENT HANDLERS ==========================
   =============================================================================
*/

/* --------------------------- UI State Variables --------------------------- */

// Holds the processed data once we upload CSVs
let data = null;

// Lists of unique course IDs & company IDs (for drop-downs)
let courses = [];
let companies = [];

// IDs of all main panels in the UI (used by show())
const panels = [
  'fileUploadPanel',
  'teacherHourCountSettings',
  'overviewSettings',
  'teacherReportPanel',
  'courseReportSettings',
  'studentReportSettings',
  'classListPanel', 
  'hourCountReportOutput',
  'teacherReportOutput',
  'allCoursesOverviewReport',
  'courseDetailedReport',
  'studentReportOutput',
  'overviewReportOutput',
  'classListReportOutput'
];

/*
 * show
 * ----
 * Hides all panels and then shows the panel with the given ID.
 *
 * @param {string} id - DOM element ID of the panel to show.
 */
function show(id) {
  panels.forEach((p) => document.getElementById(p).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}


/* --------------------------- Upload & Parsing --------------------------- */

// Grab references to file inputs and upload button
const participantsInput = document.getElementById('participantsFile');
const classesInput = document.getElementById('classesFile');
const uploadBtn = document.getElementById('uploadBtn');

// Disable upload button until both CSV files are chosen
[participantsInput, classesInput].forEach((inputEl) =>
  inputEl.addEventListener('change', () => {
    uploadBtn.disabled = !(participantsInput.files[0] && classesInput.files[0]);
  })
);

// After clicking Upload, parse both CSVs, process data, and populate UI options
uploadBtn.addEventListener('click', async () => {
  try {
    // 1) Parse both CSV files
    const [classesData, participantsData] = await Promise.all([
      parseCSVFile(classesInput.files[0]),
      parseCSVFile(participantsInput.files[0])
    ]);

    // 2) Process data into structured object
    data = processData(classesData, participantsData);

    // 3) Extract unique course IDs & companies from processed data
    courses = unique(Object.values(data).map((c) => c.course_id));
    companies = unique(Object.values(data).map((c) => c.company).filter(Boolean));

    // 4) Populate course dropdown
    document.getElementById('courseSelect').innerHTML = courses
      .map((id) => `<option>${id}</option>`)
      .join('');

    // 5) Populate company dropdown (with "All" option)
    const companySelect = document.getElementById('companySelect');
    companySelect.innerHTML = '<option value="ALL">All</option>' +
      companies.map((id) => `<option>${id}</option>`).join('');

    // 6) Enable or disable Company radio button based on whether any companies exist
    const hasCompanies = companies.length > 0;
    document.getElementById('companyRadio').disabled = !hasCompanies;

    // 7) Populate duration checkboxes (30, 60, etc.)
    const durations = [...new Set(
      Object.values(data).map((c) => Math.round(c.scheduledDuration / 60))
    )].sort((a, b) => a - b);

    const durContainer = document.getElementById('durationFilterContainer');
    durContainer.innerHTML = durations.map((d) => {
      const isChecked = (d === 30 || d === 60) ? 'checked' : '';
      return `
        <label style="margin-right:1rem;">
          <input type="checkbox" name="durationFilter" value="${d}" ${isChecked}>
          ${d} min
        </label>`;
    }).join('');

    // 8) Build list of all validated student usernames (for custom filtering)
    validatedStudentUsernames = [];
    Object.values(data).forEach((cls) => {
      (cls.students || []).forEach((s) => {
        if (s.username && !validatedStudentUsernames.includes(s.username)) {
          validatedStudentUsernames.push(s.username);
        }
      });
    });

    // 9) Show the report selector panel
    show('reportSelectorPanel');
  } catch (e) {
    console.error(e);
    alert('Parsing error: please check your CSV files.');
  }
});

// "New Upload" button reloads the page
document.getElementById('newUploadBtn').addEventListener('click', () => {
  location.reload();
});


/* --------------------------- Report Selection --------------------------- */

// When user changes the report type dropdown, show the appropriate settings panel
document.getElementById('reportSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'teacher_hour_count') show('teacherHourCountSettings');
  else if (v === 'overview') show('overviewSettings');
  else if (v === 'teacher_report') show('teacherReportPanel');
  else if (v === 'course_report') show('courseReportSettings');
  else if (v === 'student_report') show('studentReportSettings');
  else if (v === 'student_report')        show('studentReportSettings');
  else if (v === 'class_list')            show('classListPanel');
  else show('reportSelectorPanel');
});

/* ----------------------- Course Report: Toggle Course‐ID Dropdown ----------------------- */

function updateCourseSelectVisibility() {
  const wrapper = document.getElementById('courseSelectWrapper');
  // grab the checked value into a local var (don’t reference an undefined `type`)
  const selectedType = document.querySelector('input[name="courseType"]:checked').value;

  if (selectedType === 'detail' || selectedType === 'fundae') {
    wrapper.classList.remove('hidden');
  } else {
    wrapper.classList.add('hidden');
  }
}

// run on initial page load
updateCourseSelectVisibility();

// re-run whenever any of the courseType radios change
document.querySelectorAll('input[name="courseType"]').forEach(radio => {
  radio.addEventListener('change', updateCourseSelectVisibility);
});

/* ----------------------- Generate Overview Report ----------------------- */

document.getElementById('generateOverviewBtn').addEventListener('click', () => {
  const cancellationWindow = +document.getElementById('overviewCancellationWindow').value;
  const { groupData, privateData } = buildOverviewData(data, cancellationWindow);

  /*
   * render
   * -------
   * Helper to render an HTML table from a dataset (groupData or privateData)
   * and also wire up a CSV download button.
   *
   * @param {string} type - 'group' or 'private'
   * @param {Object<number, Object>} dataset - The data returned from buildOverviewData()
   * @param {string} tableId - DOM ID where to inject the HTML table
   * @param {string} downloadBtnId - DOM ID of the "Download CSV" button
   * @param {string} filename - Filename for the downloaded CSV
   */
  function render(type, dataset, tableId, downloadBtnId, filename) {
    const durations = Object.keys(dataset).map(Number).sort((a, b) => a - b);
    const header = ['Metric', ...durations.map((d) => `${d} min`), 'Total'];

    const metrics = [
      { key: 'total', label: 'Total classes' },
      { key: 'completed', label: 'Completed classes' },
      { key: 'cancelled', label: 'Cancelled classes' },
      { key: 'cancelledByStudent', label: 'Cancelled by student' },
      { key: 'cancelledByTeacher', label: 'Cancelled by teacher' },
      { key: 'cancelledByAdmin', label: 'Cancelled by admin' },
      { key: 'studentCancelledLate', label: `Student cancelled < ${cancellationWindow}h` },
      { key: 'teacherNoShow', label: 'Teacher no show' },
      { key: 'studentNoShow', label: 'Student no show' },
      { key: 'bothNoShow', label: 'No show (both)' }
    ];

    // Build CSV rows
    const csvRows = [header.join(',')];
    const tbodyRows = [];

    metrics.forEach((m) => {
      const row = [m.label];
      let totalSum = 0;
      durations.forEach((d) => {
        const v = dataset[d][m.key] || 0;
        row.push(v);
        totalSum += v;
      });
      row.push(totalSum);
      csvRows.push(row.join(','));

      // Build HTML <tr> for this metric
      const htmlRow = '<tr>' + row.map((c, i) =>
        i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`
      ).join('') + '</tr>';
      tbodyRows.push(htmlRow);
    });

    // Inject HTML table into page
    const tableHTML = '<table><thead><tr>' +
      header.map((h) => `<th>${h}</th>`).join('') +
      '</tr></thead><tbody>' +
      tbodyRows.join('') +
      '</tbody></table>';
    document.getElementById(tableId).innerHTML = tableHTML;

    // Wire download button to generate CSV
    document.getElementById(downloadBtnId).onclick = () =>
      downloadCSV(csvRows.join('\n'), filename);
  }

  // Render both group and private overview tables
  render('group', groupData, 'groupOverviewTable', 'downloadGroupOverviewBtn', 'overview-group.csv');
  render('private', privateData, 'privateOverviewTable', 'downloadPrivateOverviewBtn', 'overview-private.csv');

  // Build and inject the private averages table (HTML)
  document.getElementById('privateAveragesTable').innerHTML = buildPrivateAveragesTable(data);

  // Show the overview report panel
  show('overviewReportOutput');
});


/* ----------------------- Generate Teacher Hour Count ----------------------- */

document.getElementById('generateHourCountBtn').addEventListener('click', () => {
  // 1) Gather settings from UI
  const settings = {
    tardinessLimit: +document.getElementById('tardinessLimit').value,
    penaliseTardiness: document.getElementById('penaliseTardiness').checked,
    cancellationWindow: +document.getElementById('cancellationWindow').value,
    payLastMinuteCancellation: document.getElementById('payLastMinuteCancellation').checked,
    payStudentNoShow: document.getElementById('payStudentNoShow').checked,
    studentNoShowRate: +document.getElementById('studentNoShowRate').value, // percent
    classTypeFilter: document.querySelector('input[name="classTypeFilter"]:checked').value
  };

  // 2) Read which durations are checked
  const selectedDurations = Array.from(
    document.querySelectorAll('input[name="durationFilter"]:checked')
  ).map((el) => parseInt(el.value, 10));

  // 3) Filter processedData to only include classes whose duration (rounded minutes) is in selectedDurations
  const filteredData = Object.fromEntries(
    Object.entries(data)
      .filter(([slug, cls]) => selectedDurations.includes(Math.round(cls.scheduledDuration / 60)))
  );

  // 4) Build CSV strings (detailed and simplified)
  const detailedCsv = buildTeacherHourCountCSV(filteredData, settings, false);
  const simplifiedCsv = buildTeacherHourCountCSV(filteredData, settings, true);

  // 5) Render detailed table onto the page
  document.getElementById('hourCountTable').innerHTML = csvToTable(detailedCsv);

  // 6) Wire up download buttons
  document.getElementById('downloadHourCountBtn').onclick = () =>
    downloadCSV(detailedCsv, 'teacher-hour-count.csv');
  document.getElementById('downloadSimplifiedHourCountBtn').onclick = () =>
    downloadCSV(simplifiedCsv, 'teacher-hour-count-simple.csv');

  // 7) Show the report output panel
  show('hourCountReportOutput');
});


/* ----------------------- Generate Teacher Report (Overview & Feedback) ----------------------- */

document.getElementById('generateTeacherReportBtn').addEventListener('click', () => {
  const privateCsv = buildTeacherPrivateClassesCSV(data);
  const groupCsv   = buildTeacherGroupClassesCSV(data);
  const feedbackCsv = buildTeacherFeedbackCSV(data);

  document.getElementById('teacherPrivateTable').innerHTML = csvToTable(privateCsv);
  document.getElementById('teacherGroupTable').innerHTML   = csvToTable(groupCsv);
  document.getElementById('feedbackTable').innerHTML       = csvToTable(feedbackCsv);

  document.getElementById('downloadTeacherPrivateBtn').onclick = () => 
    downloadCSV(privateCsv, 'teacher-private-classes.csv');
  document.getElementById('downloadTeacherGroupBtn').onclick = () => 
    downloadCSV(groupCsv,   'teacher-group-classes.csv');
  document.getElementById('downloadFeedbackBtn').onclick     = () => 
    downloadCSV(feedbackCsv, 'teacher-feedback.csv');

  show('teacherReportOutput');
});


/* ----------------------- Generate Course Report (Overview vs Detail) ----------------------- */

document.getElementById('generateCourseReportBtn').addEventListener('click', () => {
  const courseType = document.querySelector('input[name="courseType"]:checked').value;
  const selectedCourseId = document.getElementById('courseSelect').value;

  if (courseType === 'overview') {
    // Build overview of all courses
    const allCoursesCsv = buildAllCoursesOverviewCSV(data);
    document.getElementById('allCoursesTable').innerHTML = csvToTable(allCoursesCsv);
    document.getElementById('downloadAllCoursesBtn').onclick = () =>
      downloadCSV(allCoursesCsv, 'courses-overview.csv');
    show('allCoursesOverviewReport');

  } else if (courseType === 'detail') {
    // Build detail for a specific course
    const { infoCsv, classListCsv } = buildCourseDetailReport(data, selectedCourseId);
    document.getElementById('courseInfoTable').innerHTML = csvToTable(infoCsv);
    document.getElementById('courseClassListTable').innerHTML = csvToTable(classListCsv);
    document.getElementById('downloadCourseInfoBtn').onclick = () =>
      downloadCSV(infoCsv, 'course-info.csv');
    document.getElementById('downloadCourseClassListBtn').onclick = () =>
      downloadCSV(classListCsv, 'course-classes.csv');

    // clear the Fundae‐only table & button
    document.getElementById('studentOverviewTable').innerHTML = '';
    document.getElementById('downloadStudentOverviewBtn').onclick = null;

    show('courseDetailedReport');

  } else if (courseType === 'fundae') {
     // Build detail + fundae for a specific course
    // 1) same course‐info + class‐list
    const { infoCsv, classListCsv } = buildCourseDetailReport(data, selectedCourseId);
    document.getElementById('courseInfoTable').innerHTML = csvToTable(infoCsv);
    document.getElementById('courseClassListTable').innerHTML = csvToTable(classListCsv);
    document.getElementById('downloadCourseInfoBtn').onclick = () =>
      downloadCSV(infoCsv, 'course-info.csv');
    document.getElementById('downloadCourseClassListBtn').onclick = () =>
      downloadCSV(classListCsv, 'course-classes.csv');

    // 2) build & render the new student overview
    const studentOverviewCsv = buildCourseStudentOverviewCSV(data, selectedCourseId);
    document.getElementById('studentOverviewTable').innerHTML = csvToTable(studentOverviewCsv);
    document.getElementById('downloadStudentOverviewBtn').onclick = () =>
      downloadCSV(studentOverviewCsv, 'course-student-overview.csv');

    show('courseDetailedReport');
  }
});


/* ----------------------- Generate Student Report ----------------------- */

let validatedStudentUsernames = []; // Populated after parsing CSVs

/*
 * updateStudentRadioUI
 * ---------------------
 * Toggles visibility of UI sections when the user switches between "All", "Company", or "Custom"
 * student selection modes. Shows/hides the company dropdown or custom tags input accordingly.
 */
function updateStudentRadioUI() {
  const selectedMode = document.querySelector('input[name="studentSelection"]:checked').value;
  document.getElementById('companySelectWrapper').classList.toggle('hidden', selectedMode !== 'company');
  document.getElementById('customListWrapper').classList.toggle('hidden', selectedMode !== 'custom');
  document.getElementById('companySelect').disabled = (selectedMode !== 'company');
}

// Attach change listener to each studentSelection radio button
document.querySelectorAll('input[name="studentSelection"]').forEach((radio) =>
  radio.addEventListener('change', updateStudentRadioUI)
);

/*
 * Add a custom student tag to the UI input area.
 * Splits comma-separated entries, trims whitespace, checks validity against validatedStudentUsernames,
 * and creates a <span> tag for each valid or invalid username.
 */
document.getElementById('addCustomStudentBtn').addEventListener('click', () => {
  const input = document.getElementById('customStudentInput');
  const tagContainer = document.getElementById('customStudentTags');

  // Split by commas, trim, filter out empties
  const usernames = input.value.split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  usernames.forEach((username) => {
    // Skip if tag already exists
    if (tagContainer.querySelector(`[data-username="${username}"]`)) return;

    // Create a new <span> for the tag
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.username = username;

    // Check validity
    const exists = validatedStudentUsernames.includes(username);
    if (!exists) {
      tag.classList.add('invalid');
      tag.innerText = `Username not found: ${username}`;
    } else {
      tag.innerText = username;
    }

    // Append an '×' removal button
    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => tag.remove();
    tag.appendChild(removeBtn);

    tagContainer.appendChild(tag);
  });

  input.value = '';
});


document.getElementById('generateStudentReportBtn').addEventListener('click', () => {
  // 1) Read cancellationWindow & selected company
  const cancellationWindow = +document.getElementById('studentCancellationWindow').value;
  const companyId = document.getElementById('companySelect').value;

  // 2) Determine filterMode ('all' | 'company' | 'custom')
  const filterMode = document.querySelector('input[name="studentSelection"]:checked').value;

  // 3) If 'custom', gather validated tags as customList
  let customList = [];
  if (filterMode === 'custom') {
    const tags = document.querySelectorAll('#customStudentTags .tag:not(.invalid)');
    customList = Array.from(tags).map((el) => el.dataset.username);
  }

  // 4) Build the CSV using buildStudentReport()
  const csv = buildStudentReport(data, {
    cancellationWindow,
    companyId,
    filterMode,
    customList
  });

  // 5) Render the resulting CSV as an HTML table and wire download button
  document.getElementById('studentReportTable').innerHTML = csvToTable(csv);
  document.getElementById('downloadStudentReportBtn').onclick = () =>
    downloadCSV(csv, 'student-report.csv');

  show('studentReportOutput');
});


/* ----------------------- Generate Class List Report ----------------------- */

// Helper to format date/time
function formatDateTime(ts) {
  const dt = new Date(ts.replace(' ', 'T'));
  return {
    date: dt.toLocaleDateString(),
    time: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

// Helper to build "by student" CSV
function buildClassListByStudentTable(data) {
  const header = [
    'Date','Time','Scheduled Duration','Actual Duration','Status','Company',
    'Subject','Level','Description','Class Slug','Group Class',
    'Student Username','Student Name','Student Attended','Student Tardiness',
    'Class Feedback','Class Rating',
    'Teacher Username','Teacher Name','Teacher Attended','Teacher Tardiness','Teacher Summary'
  ];
  const rows = [ header.join(',') ];

  Object.values(data).forEach(cls => {
    const { teacher } = cls;
    const teacherName = (teacher.firstName ? teacher.firstName : '') + ' ' + (teacher.lastName ? teacher.lastName : '');
    const teacherUsername = teacher.username || '';
    const teacherAttended = teacher.attended ? 'true' : '';
    const teacherTardiness = teacher.tardiness ? (teacher.tardiness/60).toString() : '';
    const teacherSummary = cls.teacherSummary || '';
    const isGroup = (cls.available_seats && cls.available_seats > 1) ? 'true' : 'false';

    const dt = new Date(cls.scheduledStart.replace(' ', 'T'));
    const date = dt.toLocaleDateString();
    const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const status = (cls.cancelledByStudent || cls.cancelledByTeacher || cls.cancelledByAdmin)
                    ? 'cancelled' : 'completed';

    (cls.students || []).forEach(student => {
      const studentName = (student.firstName ? student.firstName : '') + ' ' + (student.lastName ? student.lastName : '');
      const studentUsername = student.username || '';
      const studentAttended = student.attended ? 'true' : '';
      const studentTardiness = student.tardiness ? (student.tardiness/60).toString() : '';
      const feedback = student.feedback ? student.feedback.replace(/\"/g,'""') : '';
      const rating = student.rating || '';

      rows.push([
        date,
        time,
        (cls.scheduledDuration/60).toString(),
        (cls.actualDuration/60).toString(),
        status,
        cls.company,
        cls.subject,
        cls.level,
        `"${cls.description}"`,
        cls.slug,
        isGroup,
        studentUsername,
        studentName,
        studentAttended,
        studentTardiness,
        `"${feedback}"`,
        rating,
        teacherUsername,
        teacherName,
        teacherAttended,
        teacherTardiness,
        `"${teacherSummary}"`
      ].join(','));
    });
  });

  return rows.join('\n');
}

// 1. Toggle setup (OUTSIDE your generate handler)
  let classListMode = 'by_class';

  document.getElementById('classListByClassBtn').addEventListener('click', () => {
    classListMode = 'by_class';
    document.getElementById('classListByClassBtn').classList.add('active');
    document.getElementById('classListByStudentBtn').classList.remove('active');
  });
  document.getElementById('classListByStudentBtn').addEventListener('click', () => {
    classListMode = 'by_student';
    document.getElementById('classListByClassBtn').classList.remove('active');
    document.getElementById('classListByStudentBtn').classList.add('active');
  });

  // 2. Main handler
  document.getElementById('generateClassListBtn').addEventListener('click', () => {
    const mode = classListMode;


  // Prepare filtered lists
  const privateClasses = Object.values(data).filter(cls => cls.available_seats === 1);
  const groupClasses = Object.values(data).filter(cls => cls.available_seats > 1);

  // Build Private Classes CSV
  const privateHeader = [
    'Date','Time','Scheduled Duration','Actual Duration','Status','Company',
    'Subject','Level','description','Class Slug','Teacher Username','Teacher Name','Teacher Attended',
    'Teacher Tardiness','teacher summary','Student Username','Student Name','Student Attended',
    'Student Tardiness','class feedback','class rating'
  ];
  const privateRows = [ privateHeader.join(',') ];
  privateClasses.forEach(cls => {
    cls.students.forEach(student => {
      const { date, time } = formatDateTime(cls.scheduledStart);
      const status = (cls.cancelledByStudent || cls.cancelledByTeacher || cls.cancelledByAdmin)
                     ? 'cancelled' : 'completed';
      const teacherAttended = cls.teacher.attended ? 'true' : '';
      const studentAttended = student.attended ? 'true' : '';
      privateRows.push([
        date,
        time,
        (cls.scheduledDuration/60).toString(),
        (cls.actualDuration/60).toString(),
        status,
        cls.company,
        cls.subject,
        cls.level,
        `"${cls.description}"`,
        cls.slug,
        cls.teacher.username,
        (cls.teacher.firstName ? cls.teacher.firstName : '') + ' ' + (cls.teacher.lastName ? cls.teacher.lastName : ''),
        teacherAttended,
        cls.teacher.tardiness ? (cls.teacher.tardiness/60).toString() : '',
        `"${cls.teacherSummary}"`,
        student.username,
        (student.firstName ? student.firstName : '') + ' ' + (student.lastName ? student.lastName : ''),
        studentAttended,
        student.tardiness ? (student.tardiness/60).toString() : '',
        `"${student.feedback ? student.feedback.replace(/\"/g,'""') : ''}"`,
        student.rating
      ].join(','));
    });
  });
  const privateCsv = privateRows.join('\n');

  // Build Group Classes CSV
  const groupHeader = [
    'Date','Time','Scheduled Duration','Actual Duration','Status','Company',
    'Subject','Level','description','Class Slug','Teacher Username','Teacher Name','Teacher Attended',
    'Teacher Tardiness','teacher summary','Seats','Students Enrolled',
    'Students Attended','Student Usernames','class feedback','class rating'
  ];
  const groupRows = [ groupHeader.join(',') ];
  groupClasses.forEach(cls => {
    const { date, time } = formatDateTime(cls.scheduledStart);
    const status = (cls.cancelledByStudent || cls.cancelledByTeacher || cls.cancelledByAdmin)
                   ? 'cancelled' : 'completed';
    const seats = cls.available_seats;
    const studentsEnrolled = cls.students.length;
    const studentsAttended = cls.students.filter(s => s.attended).length;
    const studentNames = cls.students.map(s => s.username).join('; ');
    const allFeedback = cls.students
      .map(s => (s.feedback || '').trim())
      .filter(f => f)
      .map(f => f.replace(/\"/g,'""'))
      .map(f => `"${f}"`)
      .join(' | ');
    const ratingsArr = cls.students
      .map(s => parseFloat(s.rating))
      .filter(r => !isNaN(r));
    const avgRating = ratingsArr.length
      ? (ratingsArr.reduce((sum, r) => sum + r, 0) / ratingsArr.length).toFixed(2)
      : '';
    const teacherAttended = cls.teacher.attended ? 'true' : '';
    groupRows.push([
      date,
      time,
      (cls.scheduledDuration/60).toString(),
      (cls.actualDuration/60).toString(),
      status,
      cls.company,
      cls.subject,
      cls.level,
      `"${cls.description}"`,
      cls.slug,
      cls.teacher.username,
      (cls.teacher.firstName ? cls.teacher.firstName : '') + ' ' + (cls.teacher.lastName ? cls.teacher.lastName : ''),
      teacherAttended,
      cls.teacher.tardiness ? (cls.teacher.tardiness/60).toString() : '',
      `"${cls.teacherSummary}"`,
      seats,
      studentsEnrolled,
      studentsAttended,
      `"${studentNames}"`,
      allFeedback,
      avgRating
    ].join(','));
  });
  const groupCsv = groupRows.join('\n');

  // BY STUDENT TABLE
  const byStudentCsv = buildClassListByStudentTable(data);

  // ---- Render the right tables according to mode ----

  // Set table HTMLs
  document.getElementById('classListPrivateTable').innerHTML = csvToTable(privateCsv);
  document.getElementById('classListGroupTable').innerHTML   = csvToTable(groupCsv);
  document.getElementById('classListByStudentTable').innerHTML = csvToTable(byStudentCsv);
  
  // The by-student section is its own wrapper, toggle its display
  document.getElementById('classListByStudentSection').style.display = (mode === 'by_student') ? '' : 'none';

  // Toggle the visibility of download buttons as well
  document.getElementById('downloadPrivateClassListBtn').style.display = (mode === 'by_class') ? '' : 'none';
  document.getElementById('downloadGroupClassListBtn').style.display = (mode === 'by_class') ? '' : 'none';
  document.getElementById('downloadByStudentClassListBtn').style.display = (mode === 'by_student') ? '' : 'none';

  // Toggle private/group section visibility (including headers/hr) by mode
  document.getElementById('privateClassSection').style.display = (mode === 'by_class') ? '' : 'none';
  document.getElementById('groupClassSection').style.display = (mode === 'by_class') ? '' : 'none';
  document.getElementById('classListHR').style.display = (mode === 'by_class') ? '' : 'none';

  // Toggle by-student section
  document.getElementById('classListByStudentSection').style.display = (mode === 'by_student') ? '' : 'none';

  // Download buttons
  document.getElementById('downloadPrivateClassListBtn').onclick = () =>
    downloadCSV(privateCsv, 'class-list-private.csv');
  document.getElementById('downloadGroupClassListBtn').onclick = () =>
    downloadCSV(groupCsv,   'class-list-group.csv');
  const byStudentBtn = document.getElementById('downloadByStudentClassListBtn');
  if (byStudentBtn) {
    byStudentBtn.onclick = () =>
      downloadCSV(byStudentCsv, 'class-list-by-student.csv');
  }

  // Show result panel
  show('classListReportOutput');
});





/* ----------------------- Utility Functions ----------------------- */

/*
 * csvToTable
 * -----------
 * Converts a CSV string into an HTML <table> string. Assumes the first line is header.
 * Wraps first column of each row in <th>.
 *
 * @param {string} csv - CSV data (newline-separated rows, comma-separated columns).
 * @returns {string} HTML string containing the <table> representation.
 */
function csvToTable(csv) {
  const rows = csv.trim().split('\n');
  // Build header row
  let html = '<table><thead><tr>' +
    rows[0].split(',').map((c) =>
      `<th>${c.replace(/^"|"$/g, '')}</th>`
    ).join('') +
    '</tr></thead><tbody>';

  // Build body rows
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split(',');
    html += '<tr>' + cols.map((c, j) => {
      const cellText = c.replace(/^"|"$/g, '');
      return j === 0
        ? `<th>${cellText}</th>`
        : `<td>${cellText}</td>`;
    }).join('') + '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/*
 * downloadCSV
 * ------------
 * Triggers download of a CSV string as a file with the given filename.
 *
 * @param {string} csv - CSV content
 * @param {string} filename - Name of the downloaded file
 */
function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

