const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();

/*
  Study Farm V2
  Firebase Cloud Functions

  العمليات:
  - إنشاء/تهيئة حساب المستخدم
  - إضافة نقاط من خلال المهام
  - شراء من المتجر
  - تفعيل العناصر
  - إنشاء طلب سحب
  - إدارة المهام بواسطة الأدمن
  - إدارة المتجر بواسطة الأدمن

  ملاحظة:
  لا يتم إرسال أموال حقيقية تلقائياً من هذا الكود.
  طلبات السحب تُحفظ في Firestore ليتم مراجعتها من لوحة الأدمن.
*/

// ----------------------------------------------------
// أدوات مساعدة
// ----------------------------------------------------

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "يجب تسجيل الدخول أولاً."
    );
  }

  return request.auth.uid;
}

function requireAdmin(request) {
  const uid = requireAuth(request);

  if (request.auth.token.admin !== true) {
    throw new HttpsError(
      "permission-denied",
      "ليس لديك صلاحية الأدمن."
    );
  }

  return uid;
}

function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().substring(0, maxLength);
}

function positiveNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return number;
}

// ----------------------------------------------------
// إنشاء حساب المستخدم
// ----------------------------------------------------

exports.createProfile = onCall(async (request) => {
  const uid = requireAuth(request);

  const userRef = db.collection("users").doc(uid);
  const snapshot = await userRef.get();

  if (snapshot.exists) {
    return {
      success: true,
      message: "الحساب موجود بالفعل."
    };
  }

  await userRef.set({
    uid,
    points: 0,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    completedTasks: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    message: "تم إنشاء الحساب."
  };
});

// ----------------------------------------------------
// إكمال مهمة
// ----------------------------------------------------

exports.completeTask = onCall(async (request) => {
  const uid = requireAuth(request);

  const taskId = cleanString(request.data?.taskId, 100);

  if (!taskId) {
    throw new HttpsError(
      "invalid-argument",
      "معرف المهمة غير صحيح."
    );
  }

  const userRef = db.collection("users").doc(uid);
  const taskRef = db.collection("tasks").doc(taskId);
  const completionRef = userRef
    .collection("completedTasks")
    .doc(taskId);

  const result = await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const taskSnap = await transaction.get(taskRef);
    const completionSnap = await transaction.get(completionRef);

    if (!userSnap.exists) {
      throw new HttpsError(
        "not-found",
        "حساب المستخدم غير موجود."
      );
    }

    if (!taskSnap.exists) {
      throw new HttpsError(
        "not-found",
        "المهمة غير موجودة."
      );
    }

    if (completionSnap.exists) {
      throw new HttpsError(
        "already-exists",
        "تم تنفيذ هذه المهمة من قبل."
      );
    }

    const task = taskSnap.data();

    if (task.active !== true) {
      throw new HttpsError(
        "failed-precondition",
        "هذه المهمة غير متاحة حالياً."
      );
    }

    const reward = positiveNumber(task.reward);

    if (reward === null) {
      throw new HttpsError(
        "failed-precondition",
        "قيمة مكافأة المهمة غير صحيحة."
      );
    }

    const user = userSnap.data();

    const oldPoints = Number(user.points || 0);
    const oldBalance = Number(user.balance || 0);
    const oldTotalEarned = Number(user.totalEarned || 0);
    const oldCompleted = Number(user.completedTasks || 0);

    transaction.set(completionRef, {
      taskId,
      reward,
      completedAt: FieldValue.serverTimestamp()
    });

    transaction.update(userRef, {
      points: oldPoints + reward,
      balance: oldBalance + reward,
      totalEarned: oldTotalEarned + reward,
      completedTasks: oldCompleted + 1,
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      reward,
      newBalance: oldBalance + reward,
      newPoints: oldPoints + reward
    };
  });

  return {
    success: true,
    ...result
  };
});

// ----------------------------------------------------
// شراء منتج من المتجر
// ----------------------------------------------------

exports.buyProduct = onCall(async (request) => {
  const uid = requireAuth(request);

  const productId = cleanString(request.data?.productId, 100);

  if (!productId) {
    throw new HttpsError(
      "invalid-argument",
      "معرف المنتج غير صحيح."
    );
  }

  const userRef = db.collection("users").doc(uid);
  const productRef = db.collection("products").doc(productId);

  const result = await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const productSnap = await transaction.get(productRef);

    if (!userSnap.exists) {
      throw new HttpsError(
        "not-found",
        "حساب المستخدم غير موجود."
      );
    }

    if (!productSnap.exists) {
      throw new HttpsError(
        "not-found",
        "المنتج غير موجود."
      );
    }

    const user = userSnap.data();
    const product = productSnap.data();

    if (product.active !== true) {
      throw new HttpsError(
        "failed-precondition",
        "المنتج غير متاح."
      );
    }

    const price = positiveNumber(product.price);

    if (price === null) {
      throw new HttpsError(
        "failed-precondition",
        "سعر المنتج غير صحيح."
      );
    }

    const balance = Number(user.balance || 0);

    if (balance < price) {
      throw new HttpsError(
        "failed-precondition",
        "الرصيد غير كافٍ."
      );
    }

    const purchaseRef = userRef
      .collection("purchases")
      .doc();

    transaction.update(userRef, {
      balance: balance - price,
      updatedAt: FieldValue.serverTimestamp()
    });

    transaction.set(purchaseRef, {
      productId,
      productName: cleanString(product.name, 200),
      price,
      purchasedAt: FieldValue.serverTimestamp(),
      active: false
    });

    return {
      purchaseId: purchaseRef.id,
      remainingBalance: balance - price
    };
  });

  return {
    success: true,
    ...result
  };
});

// ----------------------------------------------------
// تفعيل عملية شراء
// ----------------------------------------------------

exports.activatePurchase = onCall(async (request) => {
  const uid = requireAuth(request);

  const purchaseId = cleanString(
    request.data?.purchaseId,
    100
  );

  if (!purchaseId) {
    throw new HttpsError(
      "invalid-argument",
      "معرف الشراء غير صحيح."
    );
  }

  const purchaseRef = db
    .collection("users")
    .doc(uid)
    .collection("purchases")
    .doc(purchaseId);

  const snap = await purchaseRef.get();

  if (!snap.exists) {
    throw new HttpsError(
      "not-found",
      "عملية الشراء غير موجودة."
    );
  }

  if (snap.data().active === true) {
    return {
      success: true,
      message: "العنصر مفعل بالفعل."
    };
  }

  await purchaseRef.update({
    active: true,
    activatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    message: "تم تفعيل العنصر."
  };
});

// ----------------------------------------------------
// إنشاء طلب سحب
// ----------------------------------------------------

exports.createWithdrawal = onCall(async (request) => {
  const uid = requireAuth(request);

  const amount = positiveNumber(request.data?.amount);
  const phone = cleanString(request.data?.phone, 30);

  if (amount === null) {
    throw new HttpsError(
      "invalid-argument",
      "قيمة السحب غير صحيحة."
    );
  }

  if (!phone || phone.length < 8) {
    throw new HttpsError(
      "invalid-argument",
      "رقم الهاتف غير صحيح."
    );
  }

  const userRef = db.collection("users").doc(uid);
  const withdrawalRef = db.collection("withdrawals").doc();

  const result = await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new HttpsError(
        "not-found",
        "حساب المستخدم غير موجود."
      );
    }

    const user = userSnap.data();
    const balance = Number(user.balance || 0);

    if (balance < amount) {
      throw new HttpsError(
        "failed-precondition",
        "الرصيد غير كافٍ."
      );
    }

    transaction.update(userRef, {
      balance: balance - amount,
      updatedAt: FieldValue.serverTimestamp()
    });

    transaction.set(withdrawalRef, {
      uid,
      amount,
      phone,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });

    return {
      withdrawalId: withdrawalRef.id,
      remainingBalance: balance - amount
    };
  });

  return {
    success: true,
    ...result
  };
});

// ----------------------------------------------------
// إنشاء مهمة - أدمن
// ----------------------------------------------------

exports.adminCreateTask = onCall(async (request) => {
  requireAdmin(request);

  const name = cleanString(request.data?.name, 200);
  const description = cleanString(
    request.data?.description,
    500
  );
  const reward = positiveNumber(request.data?.reward);

  if (!name || reward === null) {
    throw new HttpsError(
      "invalid-argument",
      "بيانات المهمة غير صحيحة."
    );
  }

  const taskRef = db.collection("tasks").doc();

  await taskRef.set({
    name,
    description,
    reward,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    taskId: taskRef.id
  };
});

// ----------------------------------------------------
// تعطيل/تفعيل مهمة - أدمن
// ----------------------------------------------------

exports.adminSetTaskStatus = onCall(async (request) => {
  requireAdmin(request);

  const taskId = cleanString(request.data?.taskId, 100);
  const active = request.data?.active;

  if (!taskId || typeof active !== "boolean") {
    throw new HttpsError(
      "invalid-argument",
      "البيانات غير صحيحة."
    );
  }

  const taskRef = db.collection("tasks").doc(taskId);

  await taskRef.update({
    active,
    updatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true
  };
});

// ----------------------------------------------------
// إنشاء منتج - أدمن
// ----------------------------------------------------

exports.adminCreateProduct = onCall(async (request) => {
  requireAdmin(request);

  const name = cleanString(request.data?.name, 200);
  const description = cleanString(
    request.data?.description,
    500
  );
  const price = positiveNumber(request.data?.price);

  if (!name || price === null) {
    throw new HttpsError(
      "invalid-argument",
      "بيانات المنتج غير صحيحة."
    );
  }

  const productRef = db.collection("products").doc();

  await productRef.set({
    name,
    description,
    price,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    productId: productRef.id
  };
});

// ----------------------------------------------------
// تغيير حالة المنتج - أدمن
// ----------------------------------------------------

exports.adminSetProductStatus = onCall(async (request) => {
  requireAdmin(request);

  const productId = cleanString(
    request.data?.productId,
    100
  );

  const active = request.data?.active;

  if (!productId || typeof active !== "boolean") {
    throw new HttpsError(
      "invalid-argument",
      "البيانات غير صحيحة."
    );
  }

  await db
    .collection("products")
    .doc(productId)
    .update({
      active,
      updatedAt: FieldValue.serverTimestamp()
    });

  return {
    success: true
  };
});

// ----------------------------------------------------
// مراجعة طلب سحب - أدمن
// ----------------------------------------------------

exports.adminUpdateWithdrawal = onCall(async (request) => {
  requireAdmin(request);

  const withdrawalId = cleanString(
    request.data?.withdrawalId,
    100
  );

  const status = cleanString(
    request.data?.status,
    30
  );

  const allowedStatuses = [
    "pending",
    "approved",
    "rejected",
    "paid"
  ];

  if (
    !withdrawalId ||
    !allowedStatuses.includes(status)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "حالة السحب غير صحيحة."
    );
  }

  const withdrawalRef = db
    .collection("withdrawals")
    .doc(withdrawalId);

  const snap = await withdrawalRef.get();

  if (!snap.exists) {
    throw new HttpsError(
      "not-found",
      "طلب السحب غير موجود."
    );
  }

  await withdrawalRef.update({
    status,
    updatedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true
  };
});

// ----------------------------------------------------
// تسجيل إنشاء طلب سحب في سجل النظام
// ----------------------------------------------------

exports.logWithdrawalCreated = onDocumentCreated(
  "withdrawals/{withdrawalId}",
  async (event) => {
    const snapshot = event.data;

    if (!snapshot) {
      return;
    }

    const data = snapshot.data();

    await db.collection("auditLogs").add({
      type: "withdrawal_created",
      withdrawalId: event.params.withdrawalId,
      uid: data.uid || null,
      amount: data.amount || 0,
      status: data.status || "pending",
      createdAt: FieldValue.serverTimestamp()
    });
  }
);
