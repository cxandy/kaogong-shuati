/**
 * zhejiang-crawler.mjs — 浙江近五年行测+申论真题爬取（纯 GET，干净接口）
 *
 * 数据源（均需 Cookie，见 cookie.txt）：
 *   行测：/api/xingce/papers/{id}/sheet           → 章节 + questionIds
 *         /api/xingce/solutions?ids=a,b,c          → 题目 + 解析 + keypoints + 组题材料
 *   申论：/api/shenlun/papers/{id}/sheet           → sheetId + chapters
 *         /api/shenlun/solution/sheet/{sheetId}?format=html → 给定资料 + 题目 + 参考范文
 *
 * 输出（生成于仓库根目录）：
 *   tiku.db        papers / questions（chapter 已按答题卡顺序写入）
 *   practice.db    question_categories / q_materials / q_material_map
 *   materials.db   materials（申论给定资料分块，供 /api/materials）
 *
 * 用法：
 *   node zhejiang-crawler.mjs                完整爬取
 *   node zhejiang-crawler.mjs --only 申论    只爬申论
 *   node zhejiang-crawler.mjs --only 行测 --limit 1   只爬第一套做验证
 * 幂等：目标 paper 已爬完则跳过；单个 paper 失败不影响其余（断点续爬）。
 * 频率：每次请求间隔 ≥4s+抖动；403/429 冷却 90s；连续失败指数退避。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FENBI_TREE } from './lib/fenbi-tree.mjs';

const ROOT = process.cwd();
const COOKIE_FILE = path.join(ROOT, 'cookie.txt');
const cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1] || '全部';
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);

const MIN_GAP = 4000;
const COOLDOWN = 90_000;
const FAIL_CAP = 6;

const PAPERS = {
  行测: [
    [8399761, '2026 浙江行测 A'],
    [7623629, '2025 浙江行测 A'],
    [6781468, '2024 浙江行测 A'],
    [198517,  '2023 浙江行测 A'],
    [183633,  '2022 浙江行测 A'],
  ],
  申论: [
    [5254748, '2026 浙江申论 A'],
    [5758153, '2026 浙江申论 B'],
    [5254772, '2026 浙江申论 C'],
    [6758563, '2025 浙江申论 A'],
    [5855987, '2025 浙江申论 B'],
    [7372606, '2025 浙江申论 C'],
    [4508683, '2024 浙江申论 A'],
    [4508685, '2024 浙江申论 B'],
    [4508686, '2024 浙江申论 C'],
    [209063,  '2023 浙江申论 A'],
    [209053,  '2023 浙江申论 B'],
    [208888,  '2023 浙江申论 C'],
  ],
};

const SUBJECTS = {
  行测: { prefix: 'xingce', subjectName: '公务员·行测', subject: 'xingce' },
  申论: { prefix: 'shenlun', subjectName: '公务员·申论', subject: 'shenlun' },
};

// ---------- HTTP ----------
let lastReq = 0;
let failStreak = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const now = Date.now();
  let wait = lastReq ? Math.max(0, MIN_GAP + Math.random() * 1500 - (now - lastReq)) : 0;
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; ; attempt++) {
    lastReq = Date.now();
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://spa.fenbi.com/', Cookie: cookie },
      });
    } catch (e) {
      failStreak++;
      if (failStreak >= FAIL_CAP) throw new Error(`网络失败已达 ${FAIL_CAP} 次：${e.message}`);
      await sleep(3000 + failStreak * 2000);
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      console.warn(`  403/429 冷却 ${COOLDOWN / 1000}s…`);
      await sleep(COOLDOWN);
      lastReq = 0;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`JSON 解析失败 ${url}（${text.slice(0, 80)}）`);
    }
  }
}

// ---------- SQLite ----------
function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

const tiku = openDb(path.join(ROOT, 'tiku.db'));
const practice = openDb(path.join(ROOT, 'practice.db'));
const matsDb = openDb(path.join(ROOT, 'materials.db'));
const nowIso = new Date().toISOString();

tiku.exec(`
  CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    subjectName TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    questionCount INTEGER,
    difficulty REAL,
    chapters TEXT,
    exerciseId INTEGER,
    crawledAt TEXT,
    time INTEGER
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    questionId INTEGER NOT NULL,
    paperId INTEGER NOT NULL,
    chapter TEXT,
    type INTEGER,
    content TEXT NOT NULL,
    contentHtml TEXT,
    options TEXT,
    answer TEXT,
    answerIndex INTEGER,
    difficulty INTEGER,
    analysis TEXT,
    source TEXT,
    analysisHtml TEXT,
    questionType INTEGER,
    optionType INTEGER,
    material TEXT,
    hasVideo INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_q_paper ON questions(paperId);
  CREATE INDEX IF NOT EXISTS idx_q_qid ON questions(questionId);
`);
practice.exec(`
  CREATE TABLE IF NOT EXISTS question_categories (
    question_id INTEGER, subject TEXT, category TEXT, sub TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_qc_uq ON question_categories(question_id, subject, category, sub);
  CREATE TABLE IF NOT EXISTS q_materials (
    material_id INTEGER, subject TEXT, content TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_qm_uq ON q_materials(material_id, subject);
  CREATE TABLE IF NOT EXISTS q_material_map (
    question_id INTEGER, subject TEXT, material_id INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_qmm_uq ON q_material_map(question_id, subject, material_id);
  CREATE INDEX IF NOT EXISTS idx_qmm ON q_material_map(question_id);
`);
matsDb.exec(`CREATE TABLE IF NOT EXISTS materials (paperId INTEGER, title TEXT, idx INTEGER, text TEXT);`);

// ---------- helpers ----------
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const paperDone = (paperId) =>
  tiku.prepare('SELECT COUNT(*) n FROM questions WHERE paperId = ?').get(paperId).n > 0;

function insertPaper(subj, sheet, chapters) {
  const p = tiku.prepare(
    `INSERT INTO papers (id, subject, subjectName, category, name, questionCount, difficulty, chapters, exerciseId, crawledAt, time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, questionCount=excluded.questionCount,
       difficulty=excluded.difficulty, chapters=excluded.chapters, crawledAt=excluded.crawledAt, time=excluded.time`
  );
  p.run(
    sheet.paperId, subj.subject, subj.subjectName, '浙江', sheet.name, sheet.questionCount,
    sheet.difficulty ?? null, JSON.stringify(chapters), sheet.id ?? null, nowIso, sheet.time ?? null
  );
}

function writeQuestions(paperId, rows) {
  tiku.prepare('DELETE FROM questions WHERE paperId = ?').run(paperId);
  const ins = tiku.prepare(
    `INSERT INTO questions (questionId, paperId, chapter, type, content, contentHtml, options, answer, answerIndex, difficulty, analysis, source, analysisHtml, questionType, optionType, material, hasVideo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) ins.run(...r);
}

function clearCategories(subjectName, questionIds) {
  const del = practice.prepare('DELETE FROM question_categories WHERE subject = ? AND question_id IN (...ids)'.replace('...ids', questionIds.map(() => '?').join(',')));
  del.run(subjectName, ...questionIds);
}
function addCategory(qid, subjectName, category, sub) {
  practice.prepare('INSERT OR IGNORE INTO question_categories (question_id, subject, category, sub) VALUES (?, ?, ?, ?)').run(qid, subjectName, category, sub);
}
function addMaterial(materialId, subjectName, content) {
  practice.prepare('INSERT OR IGNORE INTO q_materials (material_id, subject, content) VALUES (?, ?, ?)').run(materialId, subjectName, content || '');
}
function mapMaterial(questionId, subjectName, materialId) {
  practice.prepare('INSERT OR IGNORE INTO q_material_map (question_id, subject, material_id) VALUES (?, ?, ?)').run(questionId, subjectName, materialId);
}

// ---------- 行测 sub 分类（keypoints → FENBI_TREE 叶子/子模块） ----------
const subNames = new Set();
const leafToSub = new Map();
for (const g of FENBI_TREE) for (const s of g.subs) {
  subNames.add(s.name);
  for (const leaf of s.leaves || []) leafToSub.set(leaf, s.name);
}
function resolveXcSubs(keypoints) {
  const out = new Set();
  for (const kp of keypoints || []) {
    const name = kp.name;
    if (subNames.has(name)) out.add(name);
    else if (leafToSub.has(name)) out.add(leafToSub.get(name));
  }
  return [...out];
}

// ---------- 申论分类（依据题干标题启发式） ----------
function classifyShenlun(q) {
  const isEssay = q.type === 25;
  if (isEssay) return ['文章写作题', '全部'];
  const title = String((q.accessories && q.accessories[0] && (q.accessories[0].title || '')) || stripHtml(q.content));
  const T = (kw) => title.includes(kw);
  if (T('短文评') || T('短评')) return ['贯彻执行题', '简报短评类'];
  const appSub = T('讲话') || T('发言') || T('演讲') ? '讲话发言类'
    : T('倡议') || T('宣传') || T('标语') ? '宣传倡议类'
    : T('总结') || T('汇报') || T('报告') || T('综述') ? '总结汇报类'
    : T('简报') || T('短评') || T('编者按') || T('新闻') || T('导语') ? '简报短评类'
    : T('回复') || T('回信') ? '书信回复类'
    : T('方案') || T('提纲') || T('要点') || T('介绍') || T('说明') || T('指南') ? '方案提纲类'
    : '全部';
  if (T('写一份') || T('写一篇') || T('撰写') || T('起草') || T('拟写') || T('代拟') || T('写一封') || T('写一个') || T('应用文') || appSub !== '全部') {
    return ['贯彻执行题', appSub];
  }
  if (T('概括') || T('归纳') || T('梳理') || T('总结') && title.length < 120)
    return ['归纳概括题', T('问题') || T('不足') || T('困境') || T('短板') || T('难题') ? '概括问题类'
      : T('做法') || T('经验') || T('举措') || T('成效') ? '概括做法经验类'
      : T('原因') ? '概括原因类'
      : T('变化') || T('特点') || T('趋势') ? '概括变化特点类'
      : '综合概括类'];
  if (T('对策') || T('建议') || T('措施') || T('解决'))
    return ['提出对策题', T('概括') ? '概括+对策类' : '单一对策类'];
  if (T('理解') || T('含义') || T('解释') || T('谈谈对')) return ['综合分析题', '词句理解类'];
  if (T('评价') || T('评析') || T('观点') || T('看法')) return ['综合分析题', '观点评析类'];
  if (T('关系')) return ['综合分析题', '关系分析类'];
  if (T('分析') && T('问题') || T('谈谈') && T('认识') || T('现象')) return ['综合分析题', '现象分析类'];
  return ['归纳概括题', '综合概括类'];
}

// ---------- 行测爬取 ----------
async function crawlXingce(paperId, label) {
  console.log(`\n[行测] ${label} (${paperId})`);
  const sheet = await getJson(`https://tiku.fenbi.com/api/xingce/papers/${paperId}/sheet`);
  if (sheet.questionIds.length !== sheet.questionCount) {
    console.warn(`  警告：sheet 数量不一致 ${sheet.questionIds.length} vs ${sheet.questionCount}`);
  }
  const chapterPlan = [];
  let acc = 0;
  for (const c of sheet.chapters) {
    chapterPlan.push({ name: c.name, from: acc, count: c.questionCount });
    acc += c.questionCount;
  }
  const chapterOf = (idx) => chapterPlan.find((c) => idx >= c.from && idx < c.from + c.count)?.name || sheet.chapters[sheet.chapters.length - 1].name;

  const rows = [];
  const catRows = new Map();
  const mats = new Set();
  const qids = sheet.questionIds;
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const sols = await getJson(`https://tiku.fenbi.com/api/xingce/solutions?ids=${batch.join(',')}`);
    const byId = new Map(sols.map((q) => [q.id, q]));
    for (const [k, qid] of batch.entries()) {
      const q = byId.get(qid);
      if (!q) { console.warn(`  缺题 ${qid}`); continue; }
      const opts = (q.accessories && q.accessories[0] && q.accessories[0].options) || [];
      const choice = q.correctAnswer && (q.correctAnswer.choice ?? q.correctAnswer.choices);
      let answerIdx = -1;
      if (choice != null && choice !== '') {
        const first = String(choice).split(',')[0];
        answerIdx = Number(first);
      }
      const chapter = chapterOf(i + k);
      rows.push([
        qid, paperId, chapter, q.type, stripHtml(q.content), q.content || '',
        JSON.stringify(opts), answerIdx >= 0 ? (opts[answerIdx] || '') : '', answerIdx >= 0 ? answerIdx : null,
        q.difficulty ?? null, stripHtml(q.solution) || '', q.source ?? null, q.solution || null, null, null, null, q.hasVideo ?? 0,
      ]);
      catRows.set(qid, [chapter, resolveXcSubs(q.keypoints)]);
      if (q.material && typeof q.material === 'object' && q.material.id != null) {
        addMaterial(q.material.id, SUBJECTS.行测.subjectName, String(q.material.content || ''));
        mapMaterial(qid, SUBJECTS.行测.subjectName, q.material.id);
        if (q.material.content) mats.add(q.material.id);
      }
    }
    console.log(`  …第 ${i + batch.length}/${qids.length} 题`);
  }
  writeQuestions(paperId, rows);
  insertPaper(SUBJECTS.行测, sheet, sheet.chapters);
  clearCategories(SUBJECTS.行测.subjectName, Array.from(catRows.keys()));
  for (const [qid, [chapter, subs]] of catRows) {
    addCategory(qid, SUBJECTS.行测.subjectName, chapter, '全部');
    for (const s of subs) addCategory(qid, SUBJECTS.行测.subjectName, chapter, s);
  }
  console.log(`  ✓ 完成：${rows.length} 题 / ${mats.size} 材料（含章节/分类）`);
}

// ---------- 申论爬取 ----------
async function crawlShenlun(paperId, label) {
  console.log(`\n[申论] ${label} (${paperId})`);
  const sheet = await getJson(`https://tiku.fenbi.com/api/shenlun/papers/${paperId}/sheet`);
  const solsheet = await getJson(`https://tiku.fenbi.com/api/shenlun/solution/sheet/${sheet.id}?format=html`);
  const vo = solsheet.shenLunPaperSolutionVO;
  if (!vo || !vo.questions || !vo.materials) throw new Error(`申论 solution/sheet 结构异常`);
  const materialById = new Map(vo.materials.map((m) => [m.id, m]));

  const rows = [];
  const qids = sheet.questionIds;
  const expected = [...qids];
  const paperMaterials = vo.materials.map((m, i) => ({ title: `给定资料${i + 1}`, idx: i, text: stripHtml(m.content) }));

  for (const q of vo.questions) {
    const acc = q.accessories && q.accessories[0];
    const ref = (q.solutionAccessories || []).find((a) => a.label === 'reference');
    const demo = (q.solutionAccessories || []).find((a) => a.label === 'demonstrate');
    const analysis = ref && ref.content ? stripHtml(ref.content) : (demo ? stripHtml(demo.content) : '');
    rows.push([
      q.id, paperId, '作答要求', q.type, stripHtml(q.content), q.content || '',
      '[]', '', null, q.difficulty ?? null, analysis, null, null, null, null, null, q.flags ? 1 : 0,
    ]);
    if (acc && Array.isArray(acc.materialIndexes)) {
      for (const mid of acc.materialIndexes) {
        const m = materialById.get(mid);
        if (m) {
          addMaterial(mid, SUBJECTS.申论.subjectName, String(m.content || ''));
          mapMaterial(q.id, SUBJECTS.申论.subjectName, mid);
        }
      }
    }
    const [cat, sub] = classifyShenlun(q);
    addCategory(q.id, SUBJECTS.申论.subjectName, cat, '全部');
    if (sub !== '全部') addCategory(q.id, SUBJECTS.申论.subjectName, cat, sub);
  }
  if (rows.length !== expected.length) {
    console.warn(`  警告：题目数 ${rows.length} vs 答题卡 ${expected.length}（按题号顺序写入）`);
  }
  writeQuestions(paperId, rows);
  insertPaper(SUBJECTS.申论, sheet, sheet.chapters);
  matsDb.prepare('DELETE FROM materials WHERE paperId = ?').run(paperId);
  const insM = matsDb.prepare('INSERT INTO materials (paperId, title, idx, text) VALUES (?, ?, ?, ?)');
  paperMaterials.forEach((m) => insM.run(paperId, m.title, m.idx, m.text));
  console.log(`  ✓ 完成：${rows.length} 题 / ${vo.materials.length} 篇材料 / 已入 materials.db`);
}

// ---------- main ----------
async function main() {
  const extra = `（近五年 ${PAPERS.行测.length} 套行测 + ${PAPERS.申论.length} 套申论）`;
  console.log(`开始爬取浙江真题 ${extra}  cookie: ${cookie.slice(0, 14)}…`);
  const order = ['行测', '申论'];
  let done = 0, skip = 0, fail = 0;
  for (const kind of order) {
    if (only !== '全部' && only !== kind) continue;
    let papers = PAPERS[kind];
    if (limit) papers = papers.slice(0, limit);
    for (const [pid, label] of papers) {
      if (paperDone(pid)) { console.log(`跳过已完成 ${kind} ${label}`); skip++; continue; }
      try {
        if (kind === '行测') await crawlXingce(pid, label);
        else await crawlShenlun(pid, label);
        done++;
      } catch (e) {
        fail++;
        console.error(`✗ ${kind} ${label} 失败：${e.message}`);
        if (e.message.includes('用力过猛') || e.message.includes('封')) break;
        lastReq = 0; // 出错后重置节流，避免卡死
      }
    }
  }
  console.log(`\n完成：新增 ${done} / 跳过 ${skip} / 失败 ${fail}`);
  tiku.close(); practice.close(); matsDb.close();
}

main().catch((e) => { console.error(e); process.exit(1); });