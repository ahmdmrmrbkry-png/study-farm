Enter file contents here)"use strict";

const {
  onCall,
  HttpsError,
} = require("firebase-functions/v2/https");

const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ==========================================================================
   CONFIG
   ========================================================================== */

const CONFIG = {
  MIN_WITHDRAWAL: 100,
  MAX_WITHDRAWAL: 10000,

  POMODORO_MINUTES: 25,
  POMODORO_REWARD_COINS: 30,
  POMODORO_REWARD_XP: 30,

  LEVEL_XP: 100,

  MAX_NOTE_LENGTH: 500,
  MAX_TRANSACTION_LENGTH: 80,
  MAX_PHONE_LENGTH: 30,
  MAX_REFERENCE_LENGTH: 100,

  TIME_ZONE: "Africa/Cairo",
};

/* ==========================================================================
   DAILY TASKS
   ========================================================================== */

const TASKS = {
  questions_10: {
    coins: 20,
    xp: 20,
    name: "حل 10 أسئلة",
  },
  review: {
    coins: 15,
    xp: 15,
    name: "مراجعة",
  },
  reading_10: {
    coins: 10,
    xp: 10,
    name: "قراءة لمدة 10 دقائق",
  },
};

/* ==========================================================================
   FARM STORE
   ========================================================================== */

const ITEMS = {
  small_dino: {
    price: 100,
    name: "ديناصور صغير",
  },
  wood_fence: {
    price: 50,
    name: "سور خشبي",
  },
  big_dino: {
    price: 250,
    name: "ديناصور ضخم",
  },
  iron_fence: {
    price: 120,
    name: "سور حديد",
  },
  house: {
    price: 300,
    name: "بيت مزرعة",
  },
  tractor: {
    price: 200,
    name: "جرار زراعي",
  },
};

/* ==========================================================================
   HELPERS
   ========================================================================== */

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function cleanString(value, maxLength = 500) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولًا");
  }
  return request.auth.uid;
}

function requireAdmin(request) {
  const uid = requireAuth(request);
  if (!request.auth.token || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "هذه العملية متاحة للمشرفين فقط");
  }
  return uid;
}

/**
 * حساب المستوى والـ XP المتبقي بناءً على totalXp التراكمي.
 */
function calculateLevel(totalXp) {
  let remainingXp = Math.max(0, Number(totalXp) || 0);
  let level = 1;

  while (remainingXp >= level * CONFIG.LEVEL_XP) {
    remainingXp -= level * CONFIG.LEVEL_XP;
    level++;
  }

  return {
    xp: remainingXp,
    level,
  };
}

function isValidPhone(phone) {
  const value = cleanString(phone, CONFIG.MAX_PHONE_LENGTH);
  return /^[0-9+\-\s]{8,30}$/.test(value);
}

function isValidWithdrawalAmount(amount) {
  const value = Number(amount);
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= CONFIG.MIN_WITHDRAWAL &&
    value <= CONFIG.MAX_WITHDRAWAL
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

async function getUser(uid) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "بيانات المستخدم غير موجودة");
  }
  return snap;
}

async function requireActiveUser(uid) {
  const snap = await getUser(uid);
  const data = snap.data() || {};
  if (data.active !== true) {
    throw new HttpsError("permission-denied", "الحساب غير مفعل");
  }
  return snap;
}

function validateProofPath(proofPath, uid) {
  const value = cleanString(proofPath, 300);
  if (!value) {
    throw new HttpsError("invalid-argument", "يجب إرسال إثبات الدفع");
  }
  if (value.includes("..")) {
    throw new HttpsError("invalid-argument", "مسار إثبات الدفع غير صالح");
  }
  const expectedPrefix = `payment_proofs/${uid}/`;
  if (!value.startsWith(expectedPrefix)) {
    throw new HttpsError("invalid-argument", "مسار إثبات الدفع غير صالح");
  }
  return value;
}

function createCoinLedger(
  transaction,
  { id, uid, type, amount, balanceAfter, referenceId = null, description = "" }
) {
  const ref = db.collection("coinTransactions").doc(id);
  transaction.create(ref, {
    uid,
    type,
    amount,
    balanceAfter,
    referenceId,
    description: cleanString(description, CONFIG.MAX_NOTE_LENGTH),
    createdAt: FieldValue.serverTimestamp(),
  });
}

function createAdminAction(transaction, data) {
  const ref = db.collection("adminActions").doc();
  transaction.create(ref, {
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref;
}

/* ==========================================================================
   HEALTH CHECK
   ========================================================================== */

exports.healthCheck = onCall(async () => {
  return {
    ok: true,
    service: "Study Farm",
    version: "2.1.0",
    timestamp: new Date().toISOString(),
  };
});

/* ==========================================================================
   INITIALIZE USER
   ========================================================================== */

exports.initializeUser = onCall(async (request) => {
  const uid = requireAuth(request);
  const userRef = db.collection("users").doc(uid);
  const existing = await userRef.get();

  if (existing.exists) {
    return {
      ok: true,
      created: false,
      user: existing.data(),
    };
  }

  const publicId = "SF-" + uid.substring(0, 8).toUpperCase();

  const userData = {
    uid,
    publicId,
    active: false,
    coins: 0,
    totalXp: 0,
    items: {}, // Map لتخزين العناصر والكميات { itemId: quantity }
    activePomodoroId: null, // تتبع الجلسة النشطة مباشرة
    tasksCompleted: 0,
    lastStudyDay: null,
    createdAt: FieldValue.serverTimestamp(),
    lastSeen: FieldValue.serverTimestamp(),
  };

  await userRef.create(userData);

  return {
    ok: true,
    created: true,
    user: userData,
  };
});

/* ==========================================================================
   GET MY PROFILE
   ========================================================================== */

exports.getMyProfile = onCall(async (request) => {
  const uid = requireAuth(request);
  const snap = await getUser(uid);

  await snap.ref.update({
    lastSeen: FieldValue.serverTimestamp(),
  });

  const data = snap.data();
  const levelData = calculateLevel(data.totalXp || 0);

  return {
    ok: true,
    user: {
      uid: snap.id,
      ...data,
      level: levelData.level,
      xp: levelData.xp,
    },
  };
});

/* ==========================================================================
   ACTIVATION REQUEST
   ========================================================================== */

exports.submitActivationRequest = onCall(async (request) => {
  const uid = requireAuth(request);
  const proofPath = validateProofPath(request.data?.proofPath, uid);
  const transactionNumber = cleanString(
    request.data?.transactionNumber,
    CONFIG.MAX_TRANSACTION_LENGTH
  );
  const note = cleanString(request.data?.note, CONFIG.MAX_NOTE_LENGTH);

  const userSnap = await getUser(uid);
  const user = userSnap.data() || {};

  if (user.active === true) {
    throw new HttpsError("failed-precondition", "الحساب مفعل بالفعل");
  }

  const existing = await db
    .collection("activationRequests")
    .where("uid", "==", uid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!existing.empty) {
    throw new HttpsError("already-exists", "يوجد طلب تفعيل قيد المراجعة");
  }

  const requestRef = db.collection("activationRequests").doc();

  await requestRef.create({
    uid,
    publicId: user.publicId || null,
    proofPath,
    transactionNumber,
    note,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    requestId: requestRef.id,
  };
});

/* ==========================================================================
   GET ACTIVATION STATUS
   ========================================================================== */

exports.getActivationStatus = onCall(async (request) => {
  const uid = requireAuth(request);
  const userSnap = await getUser(uid);

  const result = await db
    .collection("activationRequests")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(10)
    .get();

  return {
    ok: true,
    active: userSnap.data()?.active === true,
    requests: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   COMPLETE DAILY TASK
   ========================================================================== */

exports.completeStudyTask = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  const taskId = cleanString(request.data?.taskId, 100);
  const task = TASKS[taskId];

  if (!task) {
    throw new HttpsError("invalid-argument", "المهمة غير صالحة");
  }

  const day = today();
  const claimId = `${uid}_${day}_${taskId}`;

  const userRef = db.collection("users").doc(uid);
  const claimRef = db.collection("dailyClaims").doc(claimId);

  let result;

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const claimSnap = await transaction.get(claimRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    if (claimSnap.exists) {
      throw new HttpsError("already-exists", "تم تنفيذ هذه المهمة اليوم بالفعل");
    }

    const user = userSnap.data() || {};

    if (user.active !== true) {
      throw new HttpsError("permission-denied", "الحساب غير مفعل");
    }

    const oldCoins = Math.max(0, Number(user.coins || 0));
    const newTotalXp = Math.max(0, Number(user.totalXp || 0)) + task.xp;
    const newCoins = oldCoins + task.coins;
    const levelData = calculateLevel(newTotalXp);

    transaction.update(userRef, {
      coins: newCoins,
      totalXp: newTotalXp,
      tasksCompleted: Number(user.tasksCompleted || 0) + 1,
      lastStudyDay: day,
      lastSeen: FieldValue.serverTimestamp(),
    });

    transaction.create(claimRef, {
      uid,
      taskId,
      day,
      coinsAwarded: task.coins,
      xpAwarded: task.xp,
      createdAt: FieldValue.serverTimestamp(),
    });

    createCoinLedger(transaction, {
      id: `task_${uid}_${day}_${taskId}`,
      uid,
      type: "task_reward",
      amount: task.coins,
      balanceAfter: newCoins,
      referenceId: claimId,
      description: task.name,
    });

    result = {
      coinsAwarded: task.coins,
      xpAwarded: task.xp,
      coins: newCoins,
      totalXp: newTotalXp,
      level: levelData.level,
      xp: levelData.xp,
    };
  });

  return {
    ok: true,
    ...result,
  };
});

/* ==========================================================================
   START POMODORO
   ========================================================================== */

exports.startPomodoro = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  const userRef = db.collection("users").doc(uid);
  const sessionRef = db.collection("pomodoroSessions").doc();

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};

    if (user.active !== true) {
      throw new HttpsError("permission-denied", "الحساب غير مفعل");
    }

    if (user.activePomodoroId) {
      throw new HttpsError("already-exists", "لديك جلسة Pomodoro قيد التشغيل بالفعل");
    }

    transaction.create(sessionRef, {
      uid,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.update(userRef, {
      activePomodoroId: sessionRef.id,
      lastSeen: FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
    sessionId: sessionRef.id,
    durationMinutes: CONFIG.POMODORO_MINUTES,
  };
});

/* ==========================================================================
   FINISH POMODORO
   ========================================================================== */

exports.finishPomodoro = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  const sessionId = cleanString(request.data?.sessionId, 200);

  if (!sessionId) {
    throw new HttpsError("invalid-argument", "sessionId مطلوب");
  }

  const sessionRef = db.collection("pomodoroSessions").doc(sessionId);
  const userRef = db.collection("users").doc(uid);

  let result;

  await db.runTransaction(async (transaction) => {
    const sessionSnap = await transaction.get(sessionRef);
    const userSnap = await transaction.get(userRef);

    if (!sessionSnap.exists) {
      throw new HttpsError("not-found", "جلسة Pomodoro غير موجودة");
    }

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const session = sessionSnap.data() || {};
    const user = userSnap.data() || {};

    if (session.uid !== uid) {
      throw new HttpsError("permission-denied", "لا يمكنك إنهاء جلسة مستخدم آخر");
    }

    if (session.status !== "running") {
      throw new HttpsError("failed-precondition", "الجلسة منتهية بالفعل");
    }

    if (!session.startedAt) {
      throw new HttpsError("failed-precondition", "وقت بداية الجلسة غير موجود");
    }

    const startedAt = session.startedAt.toDate();
    const elapsed = Date.now() - startedAt.getTime();
    const requiredMs = CONFIG.POMODORO_MINUTES * 60 * 1000;

    if (elapsed < requiredMs) {
      throw new HttpsError(
        "failed-precondition",
        "لم تمر مدة Pomodoro المطلوبة بعد"
      );
    }

    const oldCoins = Math.max(0, Number(user.coins || 0));
    const newTotalXp = Math.max(0, Number(user.totalXp || 0)) + CONFIG.POMODORO_REWARD_XP;
    const newCoins = oldCoins + CONFIG.POMODORO_REWARD_COINS;
    const levelData = calculateLevel(newTotalXp);

    transaction.update(userRef, {
      coins: newCoins,
      totalXp: newTotalXp,
      activePomodoroId: null, // تفريغ الجلسة النشطة
      tasksCompleted: Number(user.tasksCompleted || 0) + 1,
      lastStudyDay: today(),
      lastSeen: FieldValue.serverTimestamp(),
    });

    transaction.update(sessionRef, {
      status: "completed",
      finishedAt: FieldValue.serverTimestamp(),
      coinsAwarded: CONFIG.POMODORO_REWARD_COINS,
      xpAwarded: CONFIG.POMODORO_REWARD_XP,
    });

    createCoinLedger(transaction, {
      id: `pomodoro_${sessionId}`,
      uid,
      type: "pomodoro_reward",
      amount: CONFIG.POMODORO_REWARD_COINS,
      balanceAfter: newCoins,
      referenceId: sessionId,
      description: "مكافأة جلسة Pomodoro",
    });

    result = {
      coinsAwarded: CONFIG.POMODORO_REWARD_COINS,
      xpAwarded: CONFIG.POMODORO_REWARD_XP,
      coins: newCoins,
      totalXp: newTotalXp,
      level: levelData.level,
      xp: levelData.xp,
    };
  });

  return {
    ok: true,
    ...result,
  };
});

/* ==========================================================================
   CANCEL / RESET EXPIRED POMODORO
   ========================================================================== */

exports.cancelPomodoro = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};
    const sessionId = user.activePomodoroId;

    if (!sessionId) {
      throw new HttpsError("failed-precondition", "لا توجد جلسة نشطة لإلغائها");
    }

    const sessionRef = db.collection("pomodoroSessions").doc(sessionId);

    transaction.update(sessionRef, {
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
    });

    transaction.update(userRef, {
      activePomodoroId: null,
      lastSeen: FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   GET STORE
   ========================================================================== */

exports.getStore = onCall(async (request) => {
  requireAuth(request);

  return {
    ok: true,
    items: Object.entries(ITEMS).map(([id, item]) => ({
      id,
      ...item,
    })),
  };
});

/* ==========================================================================
   BUY STORE ITEM
   ========================================================================== */

exports.buyStoreItem = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  const itemId = cleanString(request.data?.itemId, 100);
  const item = ITEMS[itemId];

  if (!item) {
    throw new HttpsError("invalid-argument", "العنصر غير صالح");
  }

  const userRef = db.collection("users").doc(uid);
  const purchaseRef = db.collection("purchases").doc();

  let result;

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};

    if (user.active !== true) {
      throw new HttpsError("permission-denied", "الحساب غير مفعل");
    }

    const coins = Math.max(0, Number(user.coins || 0));

    if (coins < item.price) {
      throw new HttpsError("failed-precondition", "العملات غير كافية");
    }

    // إدارة عناصر المزرعة كـ Object لتخزين الكميات (دعم التكرار)
    const items =
      typeof user.items === "object" && !Array.isArray(user.items) && user.items !== null
        ? { ...user.items }
        : {};

    const currentQty = Number(items[itemId] || 0);
    items[itemId] = currentQty + 1;

    const remainingCoins = coins - item.price;

    transaction.update(userRef, {
      coins: remainingCoins,
      items,
      lastSeen: FieldValue.serverTimestamp(),
    });

    transaction.create(purchaseRef, {
      uid,
      itemId,
      itemName: item.name,
      price: item.price,
      createdAt: FieldValue.serverTimestamp(),
    });

    createCoinLedger(transaction, {
      id: `purchase_${purchaseRef.id}`,
      uid,
      type: "purchase",
      amount: -item.price,
      balanceAfter: remainingCoins,
      referenceId: purchaseRef.id,
      description: `شراء ${item.name}`,
    });

    result = {
      itemId,
      quantity: items[itemId],
      remainingCoins,
    };
  });

  return {
    ok: true,
    ...result,
  };
});

/* ==========================================================================
   REQUEST WITHDRAWAL
   ========================================================================== */

exports.requestWithdrawal = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireActiveUser(uid);

  // التحقق المسبق من وجود طلبات معلقة قبل بدء الـ Transaction لتفادي أخطاء الاستعلامات المتغيرة
  const pendingSnap = await db
    .collection("withdrawalRequests")
    .where("uid", "==", uid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!pendingSnap.empty) {
    throw new HttpsError("already-exists", "لديك طلب سحب قيد المراجعة بالفعل");
  }

  const amount = Number(request.data?.amount);
  const phone = cleanString(request.data?.phone, CONFIG.MAX_PHONE_LENGTH);
  const method = cleanString(request.data?.method, 50);
  const note = cleanString(request.data?.note, CONFIG.MAX_NOTE_LENGTH);

  if (method !== "vodafone_cash") {
    throw new HttpsError("invalid-argument", "طريقة السحب غير مدعومة");
  }

  if (!isValidWithdrawalAmount(amount)) {
    throw new HttpsError(
      "invalid-argument",
      `مبلغ السحب يجب أن يكون بين ${CONFIG.MIN_WITHDRAWAL} و ${CONFIG.MAX_WITHDRAWAL}`
    );
  }

  if (!isValidPhone(phone)) {
    throw new HttpsError("invalid-argument", "رقم الهاتف غير صالح");
  }

  const userRef = db.collection("users").doc(uid);
  const withdrawalRef = db.collection("withdrawalRequests").doc();

  let result;

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};

    if (user.active !== true) {
      throw new HttpsError("permission-denied", "الحساب غير مفعل");
    }

    const coins = Math.max(0, Number(user.coins || 0));

    if (coins < amount) {
      throw new HttpsError("failed-precondition", "رصيد العملات غير كاف");
    }

    const remainingCoins = coins - amount;

    transaction.update(userRef, {
      coins: remainingCoins,
      lastSeen: FieldValue.serverTimestamp(),
    });

    transaction.create(withdrawalRef, {
      uid,
      publicId: user.publicId || null,
      amount,
      method,
      phone,
      note,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    createCoinLedger(transaction, {
      id: `withdrawal_${withdrawalRef.id}_debit`,
      uid,
      type: "withdrawal",
      amount: -amount,
      balanceAfter: remainingCoins,
      referenceId: withdrawalRef.id,
      description: "طلب سحب Vodafone Cash",
    });

    result = {
      requestId: withdrawalRef.id,
      remainingCoins,
    };
  });

  return {
    ok: true,
    ...result,
  };
});

/* ==========================================================================
   GET MY WITHDRAWALS
   ========================================================================== */

exports.getMyWithdrawals = onCall(async (request) => {
  const uid = requireAuth(request);

  const result = await db
    .collection("withdrawalRequests")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();

  return {
    ok: true,
    requests: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   GET MY COIN TRANSACTIONS
   ========================================================================== */

exports.getMyCoinTransactions = onCall(async (request) => {
  const uid = requireAuth(request);

  const result = await db
    .collection("coinTransactions")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  return {
    ok: true,
    transactions: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   ADMIN - LIST ACTIVATION REQUESTS
   ========================================================================== */

exports.adminGetActivationRequests = onCall(async (request) => {
  requireAdmin(request);

  const status = cleanString(request.data?.status || "pending", 50);
  const allowedStatuses = ["pending", "approved", "rejected"];

  if (!allowedStatuses.includes(status)) {
    throw new HttpsError("invalid-argument", "حالة الطلب غير صالحة");
  }

  const result = await db
    .collection("activationRequests")
    .where("status", "==", status)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  return {
    ok: true,
    requests: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   ADMIN - APPROVE ACTIVATION
   ========================================================================== */

exports.approveActivation = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 200);

  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId مطلوب");
  }

  const requestRef = db.collection("activationRequests").doc(requestId);

  await db.runTransaction(async (transaction) => {
    const requestSnap = await transaction.get(requestRef);

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "طلب التفعيل غير موجود");
    }

    const requestData = requestSnap.data() || {};

    if (requestData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "طلب التفعيل تمت مراجعته بالفعل"
      );
    }

    const uid = requestData.uid;

    if (!uid) {
      throw new HttpsError("data-loss", "طلب التفعيل لا يحتوي على UID");
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    transaction.update(userRef, {
      active: true,
      activatedAt: FieldValue.serverTimestamp(),
      activatedBy: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(requestRef, {
      status: "approved",
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid,
    });

    createAdminAction(transaction, {
      adminUid,
      action: "approve_activation",
      targetUid: uid,
      requestId,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - REJECT ACTIVATION
   ========================================================================== */

exports.rejectActivation = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 200);
  const reason = cleanString(
    request.data?.reason || "لم يتم اعتماد الطلب",
    CONFIG.MAX_NOTE_LENGTH
  );

  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId مطلوب");
  }

  const requestRef = db.collection("activationRequests").doc(requestId);

  await db.runTransaction(async (transaction) => {
    const requestSnap = await transaction.get(requestRef);

    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "طلب التفعيل غير موجود");
    }

    const data = requestSnap.data() || {};

    if (data.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "طلب التفعيل تمت مراجعته بالفعل"
      );
    }

    transaction.update(requestRef, {
      status: "rejected",
      rejectionReason: reason,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid,
    });

    createAdminAction(transaction, {
      adminUid,
      action: "reject_activation",
      targetUid: data.uid || null,
      requestId,
      reason,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - LIST WITHDRAWALS
   ========================================================================== */

exports.adminGetWithdrawalRequests = onCall(async (request) => {
  requireAdmin(request);

  const status = cleanString(request.data?.status || "pending", 50);
  const allowedStatuses = ["pending", "approved", "rejected"];

  if (!allowedStatuses.includes(status)) {
    throw new HttpsError("invalid-argument", "حالة السحب غير صالحة");
  }

  const result = await db
    .collection("withdrawalRequests")
    .where("status", "==", status)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  return {
    ok: true,
    requests: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   ADMIN - APPROVE WITHDRAWAL
   ========================================================================== */

exports.approveWithdrawal = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 200);
  const transferReference = cleanString(
    request.data?.transferReference,
    CONFIG.MAX_REFERENCE_LENGTH
  );

  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId مطلوب");
  }

  if (!transferReference) {
    throw new HttpsError("invalid-argument", "رقم التحويل مطلوب");
  }

  const withdrawalRef = db.collection("withdrawalRequests").doc(requestId);

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(withdrawalRef);

    if (!snap.exists) {
      throw new HttpsError("not-found", "طلب السحب غير موجود");
    }

    const data = snap.data() || {};

    if (data.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "طلب السحب تمت معالجته بالفعل"
      );
    }

    const amount = Number(data.amount || 0);

    if (!isValidWithdrawalAmount(amount)) {
      throw new HttpsError("data-loss", "مبلغ طلب السحب غير صحيح");
    }

    transaction.update(withdrawalRef, {
      status: "approved",
      transferReference,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid,
    });

    createAdminAction(transaction, {
      adminUid,
      action: "approve_withdrawal",
      targetUid: data.uid || null,
      requestId,
      amount,
      transferReference,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - REJECT WITHDRAWAL
   ========================================================================== */

exports.rejectWithdrawal = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 200);
  const reason = cleanString(
    request.data?.reason || "تم رفض طلب السحب",
    CONFIG.MAX_NOTE_LENGTH
  );

  if (!requestId) {
    throw new HttpsError("invalid-argument", "requestId مطلوب");
  }

  const withdrawalRef = db.collection("withdrawalRequests").doc(requestId);

  await db.runTransaction(async (transaction) => {
    const withdrawalSnap = await transaction.get(withdrawalRef);

    if (!withdrawalSnap.exists) {
      throw new HttpsError("not-found", "طلب السحب غير موجود");
    }

    const data = withdrawalSnap.data() || {};

    if (data.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "طلب السحب تمت معالجته بالفعل"
      );
    }

    const uid = data.uid;
    const amount = Number(data.amount || 0);

    if (!uid || !isValidWithdrawalAmount(amount)) {
      throw new HttpsError("data-loss", "بيانات طلب السحب غير صحيحة");
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};
    const oldCoins = Math.max(0, Number(user.coins || 0));
    const newCoins = oldCoins + amount;

    transaction.update(userRef, {
      coins: newCoins,
      lastSeen: FieldValue.serverTimestamp(),
    });

    transaction.update(withdrawalRef, {
      status: "rejected",
      rejectionReason: reason,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid,
    });

    createCoinLedger(transaction, {
      id: `withdrawal_${requestId}_refund`,
      uid,
      type: "withdrawal_refund",
      amount,
      balanceAfter: newCoins,
      referenceId: requestId,
      description: "إرجاع مبلغ السحب بعد الرفض",
    });

    createAdminAction(transaction, {
      adminUid,
      action: "reject_withdrawal",
      targetUid: uid,
      requestId,
      amount,
      reason,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - GET USER
   ========================================================================== */

exports.adminGetUser = onCall(async (request) => {
  requireAdmin(request);
  const uid = cleanString(request.data?.uid, 200);

  if (!uid) {
    throw new HttpsError("invalid-argument", "uid مطلوب");
  }

  const snap = await getUser(uid);
  const data = snap.data();
  const levelData = calculateLevel(data.totalXp || 0);

  return {
    ok: true,
    user: {
      uid: snap.id,
      ...data,
      level: levelData.level,
      xp: levelData.xp,
    },
  };
});

/* ==========================================================================
   ADMIN - ACTIVATE / DEACTIVATE USER
   ========================================================================== */

exports.adminSetUserActive = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const uid = cleanString(request.data?.uid, 200);

  if (!uid) {
    throw new HttpsError("invalid-argument", "uid مطلوب");
  }

  if (typeof request.data?.active !== "boolean") {
    throw new HttpsError("invalid-argument", "active يجب أن يكون true أو false");
  }

  const active = request.data.active;
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    transaction.update(userRef, {
      active,
      updatedBy: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    createAdminAction(transaction, {
      adminUid,
      action: active ? "activate_user" : "deactivate_user",
      targetUid: uid,
    });
  });

  return {
    ok: true,
    active,
  };
});

/* ==========================================================================
   ADMIN - ADD COINS
   ========================================================================== */

exports.adminAddCoins = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const uid = cleanString(request.data?.uid, 200);
  const amount = Number(request.data?.amount);
  const reason = cleanString(
    request.data?.reason || "إضافة من الإدارة",
    CONFIG.MAX_NOTE_LENGTH
  );

  if (!uid) {
    throw new HttpsError("invalid-argument", "uid مطلوب");
  }

  if (!isPositiveInteger(amount) || amount > 100000) {
    throw new HttpsError("invalid-argument", "قيمة العملات غير صالحة");
  }

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};
    const oldCoins = Math.max(0, Number(user.coins || 0));
    const newCoins = oldCoins + amount;

    transaction.update(userRef, {
      coins: newCoins,
      lastSeen: FieldValue.serverTimestamp(),
    });

    const actionRef = createAdminAction(transaction, {
      adminUid,
      action: "add_coins",
      targetUid: uid,
      amount,
      reason,
    });

    createCoinLedger(transaction, {
      id: `admin_add_${actionRef.id}`,
      uid,
      type: "admin_add",
      amount,
      balanceAfter: newCoins,
      referenceId: actionRef.id,
      description: reason,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - REMOVE COINS
   ========================================================================== */

exports.adminRemoveCoins = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const uid = cleanString(request.data?.uid, 200);
  const amount = Number(request.data?.amount);
  const reason = cleanString(
    request.data?.reason || "خصم من الإدارة",
    CONFIG.MAX_NOTE_LENGTH
  );

  if (!uid) {
    throw new HttpsError("invalid-argument", "uid مطلوب");
  }

  if (!isPositiveInteger(amount) || amount > 100000) {
    throw new HttpsError("invalid-argument", "قيمة العملات غير صالحة");
  }

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "المستخدم غير موجود");
    }

    const user = userSnap.data() || {};
    const oldCoins = Math.max(0, Number(user.coins || 0));

    if (oldCoins < amount) {
      throw new HttpsError("failed-precondition", "رصيد المستخدم غير كاف");
    }

    const newCoins = oldCoins - amount;

    transaction.update(userRef, {
      coins: newCoins,
      lastSeen: FieldValue.serverTimestamp(),
    });

    const actionRef = createAdminAction(transaction, {
      adminUid,
      action: "remove_coins",
      targetUid: uid,
      amount,
      reason,
    });

    createCoinLedger(transaction, {
      id: `admin_remove_${actionRef.id}`,
      uid,
      type: "admin_remove",
      amount: -amount,
      balanceAfter: newCoins,
      referenceId: actionRef.id,
      description: reason,
    });
  });

  return {
    ok: true,
  };
});

/* ==========================================================================
   ADMIN - GET COIN TRANSACTIONS
   ========================================================================== */

exports.adminGetCoinTransactions = onCall(async (request) => {
  requireAdmin(request);

  const uid = cleanString(request.data?.uid, 200);

  if (!uid) {
    throw new HttpsError("invalid-argument", "uid مطلوب");
  }

  const result = await db
    .collection("coinTransactions")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  return {
    ok: true,
    transactions: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});

/* ==========================================================================
   ADMIN - GET PURCHASES
   ========================================================================== */

exports.adminGetPurchases = onCall(async (request) => {
  requireAdmin(request);

  const uid = cleanString(request.data?.uid, 200);

  let query = db.collection("purchases").orderBy("createdAt", "desc").limit(100);

  if (uid) {
    query = db
      .collection("purchases")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(100);
  }

  const result = await query.get();

  return {
    ok: true,
    purchases: result.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })),
  };
});
