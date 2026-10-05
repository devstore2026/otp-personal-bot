const axios = require('axios');

const BASE_URL = 'https://5sim.net/v1';

const headers = () => ({
  Authorization: `Bearer ${process.env.FIVE_SIM_TOKEN}`,
  Accept: 'application/json',
});

// رصيد الحساب الحقيقي
async function getProfile() {
  const { data } = await axios.get(`${BASE_URL}/user/profile`, {
    headers: headers(),
    timeout: 15000,
  });
  return data; // { email, balance, rating, ... }
}

// أسعار وعروض خدمة معينة (ضيف — بدون توكن)
async function getPrices(service) {
  const { data } = await axios.get(`${BASE_URL}/guest/prices`, {
    params: { product: service },
    timeout: 20000,
  });
  return data; // { country: { operator: { cost, count, rate } } }
}

// شراء رقم تفعيل
async function buyActivation(country, operator, service) {
  const { data } = await axios.get(
    `${BASE_URL}/user/buy/activation/${country}/${operator}/${service}`,
    { headers: headers(), timeout: 20000 }
  );
  return data; // { id, phone, operator, product, price, status, expires, sms, ... }
}

// فحص حالة الطلب
async function checkOrder(orderId) {
  const { data } = await axios.get(`${BASE_URL}/user/check/${orderId}`, {
    headers: headers(),
    timeout: 15000,
  });
  return data; // { id, phone, status, sms: [ { code, text, ... } ], ... }
}

// إنهاء الطلب بعد استلام الكود
async function finishOrder(orderId) {
  const { data } = await axios.get(`${BASE_URL}/user/finish/${orderId}`, {
    headers: headers(),
    timeout: 15000,
  });
  return data;
}

// إلغاء الطلب واسترداد الرصيد
async function cancelOrder(orderId) {
  const { data } = await axios.get(`${BASE_URL}/user/cancel/${orderId}`, {
    headers: headers(),
    timeout: 15000,
  });
  return data;
}

// تبليغ أن الرقم محظور
async function banOrder(orderId) {
  const { data } = await axios.get(`${BASE_URL}/user/ban/${orderId}`, {
    headers: headers(),
    timeout: 15000,
  });
  return data;
}

/**
 * استخراج أفضل العروض لخدمة معينة:
 * - استبعاد المخزون الصفري (count === 0)
 * - استبعاد نسبة وصول أقل من 40%
 * - ترتيب تصاعدي حسب السعر وإرجاع أفضل limit عرض
 */
async function getBestOffers(service, limit = 8) {
  const data = await getPrices(service);
  const offers = [];

  for (const [country, operators] of Object.entries(data || {})) {
    if (!operators || typeof operators !== 'object') continue;
    for (const [operator, info] of Object.entries(operators)) {
      if (!info || typeof info !== 'object') continue;
      const cost = Number(info.cost);
      const count = Number(info.count);
      const rate = Number(info.rate);
      if (!count || count <= 0) continue;      // استبعاد المخزون الصفري
      if (Number.isNaN(rate) || rate < 40) continue; // استبعاد نسبة الوصول الضعيفة
      if (Number.isNaN(cost)) continue;
      offers.push({ country, operator, cost, count, rate });
    }
  }

  offers.sort((a, b) => a.cost - b.cost);
  return offers.slice(0, limit);
}

module.exports = {
  getProfile,
  getPrices,
  buyActivation,
  checkOrder,
  finishOrder,
  cancelOrder,
  banOrder,
  getBestOffers,
};
