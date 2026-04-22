export const SHOPEE_AFFILIATE_LINKS = [
  "https://shope.ee/example1", // ลิงก์ที่ 1
  "https://shope.ee/example2", // ลิงก์ที่ 2
  "https://shope.ee/example3", // ลิงก์ที่ 3
  "https://shope.ee/example4", // ลิงก์ที่ 4
  "https://shope.ee/example5", // ลิงก์ที่ 5
];

export const getRandomAffiliateLink = () => {
  const randomIndex = Math.floor(Math.random() * SHOPEE_AFFILIATE_LINKS.length);
  return SHOPEE_AFFILIATE_LINKS[randomIndex];
};

export const USAGE_LIMITS = {
  DAILY: 3,   // จำนวนครั้งต่อวัน
  WEEKLY: 10, // จำนวนครั้งต่อสัปดาห์
};
