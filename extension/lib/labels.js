export const FAMILY_COLORS = {
  positive:  { light: { bg: '#dcfce7', fg: '#166534' }, dark: { bg: '#14532d', fg: '#bbf7d0' } },
  neutral:   { light: { bg: '#e2e8f0', fg: '#334155' }, dark: { bg: '#334155', fg: '#e2e8f0' } },
  negative:  { light: { bg: '#fee2e2', fg: '#991b1b' }, dark: { bg: '#7f1d1d', fg: '#fecaca' } },
  political: { light: { bg: '#ede9fe', fg: '#5b21b6' }, dark: { bg: '#4c1d95', fg: '#ddd6fe' } },
};

export const DEFAULT_LABELS = [
  { key: 'thanh',       label: 'Thánh',           family: 'positive',  description: 'Kiến thức sâu, dẫn chứng cụ thể, giải đáp thắc mắc cho người khác' },
  { key: 'nghiem_tuc',  label: 'Nghiêm túc',      family: 'positive',  description: 'Thảo luận đàng hoàng, trung lập, có lý lẽ, không công kích cá nhân' },
  { key: 'ca_khia',     label: 'Cà khịa',         family: 'neutral',   description: 'Mỉa mai, chọc ngoáy, nói lái — nhưng vẫn có nội dung và quan điểm' },
  { key: 'spam',        label: 'Spam/bot',        family: 'neutral',   description: 'Quảng cáo, rao bán, lặp lại một nội dung, hoặc vô nghĩa hoàn toàn' },
  { key: 'giao_su_mom', label: 'Giáo sư mõm',     family: 'negative',  description: 'Thích lên lớp nhưng kiến thức rỗng, nói suông, không dẫn chứng' },
  { key: 'thanh_chui',  label: 'Thánh chửi',      family: 'negative',  description: 'Nổi tiếng vì chửi bới, công kích cá nhân, hạ nhục người khác' },
  { key: 'troll',       label: 'Troll',           family: 'negative',  description: 'Cố tình gây tranh cãi, chọc tức, phá thread, không đóng góp nội dung' },
  { key: 'trau',        label: 'Trẩu / Trẻ trâu', family: 'negative',  description: 'Người trẻ, nông nổi, phát ngôn thiếu chín chắn' },
  { key: 'wumao',       label: 'Wumao',           family: 'negative',  description: 'Nói sáo rỗng, a dua theo số đông, "bài viết hay quá", không có ý kiến riêng' },
  { key: 'bo_do',       label: 'Bò đỏ',           family: 'political', description: 'Bảo vệ quan điểm Đảng/Nhà nước VN' },
  { key: 'ro_tau',      label: 'Rồ tàu',          family: 'political', description: 'Thân Trung Quốc, bênh vực chính sách TQ' },
  { key: 'ro_meo',      label: 'Rồ mẽo',          family: 'political', description: 'Thân Mỹ, ca ngợi dân chủ phương Tây' },
  { key: 'ba_que',      label: '3 củ / 3que',     family: 'political', description: 'Chống cộng; gốc "cờ vàng ba sọc"' },
  { key: 'tu_nhuc',     label: 'Tự nhục',         family: 'political', description: 'Tự hạ thấp dân tộc hoặc bản thân người Việt' },
  { key: 'sinh_ngoai',  label: 'Sính ngoại',      family: 'political', description: 'Ưa chuộng nước ngoài quá mức' },
  { key: 'ech_xanh',    label: 'Ếch xanh',        family: 'political', description: 'Ngây thơ, thiếu hiểu biết chính trị' },
];

export const ARCHETYPE_INSTRUCTIONS =
  'Phân loại kiểu thành viên diễn đàn dựa trên các bình luận sau. ' +
  'Chỉ dựa vào nội dung bình luận.';

export const LEAN_QUESTIONS = {
  proGov:          'Có bảo vệ quan điểm Đảng/Nhà nước VN không?',
  proChina:        'Có thân Trung Quốc, bênh vực chính sách TQ không?',
  proUS:           'Có thân Mỹ, ca ngợi dân chủ phương Tây không?',
  antiGov:         'Có chống cộng, thái độ với chế độ hiện tại không?',
  selfDeprecating: 'Có tự hạ thấp dân tộc hoặc người Việt không?',
  xenophile:       'Có ưa chuộng nước ngoài quá mức không?',
};

/** Hash of everything that changes what jev is asked. */
export function labelSetHash(labels, leanQuestions) {
  const criteria = [...labels]
    .map((l) => `${l.key}:${l.description}`)
    .sort()
    .join('|');
  const leans = Object.entries(leanQuestions)
    .map(([k, v]) => `${k}:${v}`)
    .sort()
    .join('|');
  const input = `${criteria}##${leans}`;
  // FNV-1a, 32-bit. No node crypto: this must run in a service worker too.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
