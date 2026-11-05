// 课程术语表、ML/统计"常被听错"起始词表、领域词典，以及纠错的扫描/应用/撤销。纯函数。
import { esc } from './util.js';

// ---------- 领域词典（离线词汇释义）：[term, pos, zh, en, fr, aliases[], heardAs[]] ----------
const D = (term, pos, zh, en, fr, aliases = [], heardAs = []) => ({ term, pos, kind: 'term', def: { zh, en, fr }, aliases, heardAs });
export const DOMAIN = [
  D('decision tree', 'n.', '决策树', 'A model that classifies data by asking a sequence of questions about the features.', 'arbre de décision', ['decision trees'], ['decision treats', 'decision treatment']),
  D('random forest', 'n.', '随机森林', 'An ensemble of many decision trees trained on random subsets of the data and features.', 'forêt aléatoire', ['random forests']),
  D('node', 'n.', '节点', 'A point in a tree where a test is applied or a decision is made.', 'nœud', ['nodes']),
  D('split', 'n./v.', '分裂；划分', 'A test on one feature that divides the data into two groups.', 'séparation (split)', ['splits', 'splitting'], ['decision speed']),
  D('leaf', 'n.', '叶节点', 'A final node of a tree that gives the prediction.', 'feuille', ['leaves']),
  D('feature', 'n.', '特征', 'An input variable used to describe each example.', 'caractéristique (variable)', ['features']),
  D('label', 'n.', '标签', 'The correct class or value attached to a training example.', 'étiquette', ['labels']),
  D('Gini impurity', 'n.', '基尼不纯度', 'A score of how mixed the classes are inside a group; 0 means a pure group.', 'impureté de Gini', ['gini score', 'gini index'], ["Ginny's score", 'genius score', 'genius purity score', 'injury scope', 'charity score', 'insurance score']),
  D('entropy', 'n.', '熵', 'A measure of uncertainty or disorder in the class distribution.', 'entropie', []),
  D('information gain', 'n.', '信息增益', 'The drop in entropy obtained by a split.', "gain d'information", []),
  D('overfitting', 'n.', '过拟合', 'When a model learns noise in the training data and generalises badly.', 'surapprentissage (surajustement)', ['overfit', 'overfits', 'over fitting'], ['over fitting']),
  D('underfitting', 'n.', '欠拟合', 'When a model is too simple to capture the pattern in the data.', 'sous-apprentissage', ['underfit']),
  D('bias-variance trade-off', 'n.', '偏差-方差权衡', 'The balance between a model that is too simple (bias) and too sensitive to the data (variance).', 'compromis biais-variance', ['bias variance tradeoff', 'bias-variance tradeoff', 'bias variance trade-off'], ['biased variance trade']),
  D('bagging', 'n.', '装袋法（自助聚合）', 'Training several models on bootstrap samples and averaging their predictions.', 'bagging (agrégation de bootstrap)', []),
  D('bootstrap', 'n./v.', '自助采样', 'Random sampling with replacement to create new training sets.', 'bootstrap (rééchantillonnage)', []),
  D('ensemble', 'n.', '集成（方法）', 'A model made of many models whose outputs are combined.', "méthode d'ensemble", ['ensembles']),
  D('pruning', 'n.', '剪枝', 'Removing branches of a tree to reduce overfitting.', 'élagage', ['prune', 'pruned']),
  D('hyperparameter', 'n.', '超参数', 'A setting chosen before training, such as the depth of a tree.', 'hyperparamètre', ['hyperparameters']),
  D('support vector machine', 'n.', '支持向量机', 'A classifier that finds the boundary with the widest margin between classes.', 'machine à vecteurs de support', ['svm', 'support vector machines'], ['super vector machine']),
  D('support vector', 'n.', '支持向量', 'A training point lying on the margin; it alone defines the boundary.', 'vecteur de support', ['support vectors'], ['super vector', 'super vectors']),
  D('hyperplane', 'n.', '超平面', 'The generalisation of a line or plane to higher dimensions that separates classes.', 'hyperplan', ['hyperplanes'], ['hyper plane']),
  D('margin', 'n.', '间隔', 'The distance between the decision boundary and the closest points.', 'marge', ['margins']),
  D('decision boundary', 'n.', '决策边界', 'The surface that separates the predicted classes.', 'frontière de décision', ['boundary decision', 'decision boundaries']),
  D('kernel function', 'n.', '核函数', 'A function that gives the dot product in a higher-dimensional space without computing it.', 'fonction noyau', ['kernel trick', 'kernel'], ['kernel fashion']),
  D('dot product', 'n.', '点积', 'The sum of the products of matching components of two vectors.', 'produit scalaire', ['dot products'], ['dog product', 'dog products']),
  D('normal vector', 'n.', '法向量', 'A vector perpendicular to a hyperplane; it gives its direction.', 'vecteur normal', []),
  D('linear regression', 'n.', '线性回归', 'A model that predicts a number as a weighted sum of the features.', 'régression linéaire', [], ['linear reversion']),
  D('logistic regression', 'n.', '逻辑回归', 'A model that predicts the probability of a class with a sigmoid function.', 'régression logistique', [], ['logistic reversion', 'logistic progression']),
  D('classification', 'n.', '分类', 'Predicting which category an example belongs to.', 'classification', []),
  D('misclassification error', 'n.', '误分类误差', 'The fraction of examples that the model classifies wrongly.', 'erreur de classification', ['classification error'], ['risk specification error']),
  D('regularization', 'n.', '正则化', 'Adding a penalty to the loss to keep the model simple.', 'régularisation', ['regularisation']),
  D('cross-validation', 'n.', '交叉验证', 'Evaluating a model by training and testing on several splits of the data.', 'validation croisée', ['cross validation']),
  D('loss function', 'n.', '损失函数', 'A function that measures how wrong the predictions are.', 'fonction de perte', ['loss']),
  D('hinge loss', 'n.', '合页损失', 'The loss used by SVMs; it penalises points inside or on the wrong side of the margin.', 'perte charnière', []),
  D('gradient descent', 'n.', '梯度下降', 'An algorithm that reduces the loss by moving against the gradient.', 'descente de gradient', []),
  D('training set', 'n.', '训练集', 'The data used to fit the model.', "jeu d'entraînement", ['training data']),
  D('test set', 'n.', '测试集', 'Held-out data used to evaluate the final model.', 'jeu de test', ['test data']),
  D('feature space', 'n.', '特征空间', 'The space whose axes are the features.', 'espace des caractéristiques', []),
  D('linearly separable', 'adj.', '线性可分', 'Classes that can be separated by a straight line or hyperplane.', 'linéairement séparable', ['linear separable']),
];

// ---------- 起始"常被听错"词表（来自样本观察；仅作为建议，需用户确认）----------
// [wrong, right, reason]
export const STARTER_FIXES = [
  ['dog products', 'dot products', '近音 /t/→/g/'],
  ['dog product', 'dot product', '近音 /t/→/g/'],
  ['decision treatments', 'decision trees', '近音'],
  ['decision treatment', 'decision trees', '近音'],
  ['decision treats', 'decision trees', '近音'],
  ['decision treat', 'decision tree', '近音'],
  ['linear reversion', 'linear regression', '近音'],
  ['linear reversions', 'linear regression', '近音'],
  ['logistic reversions', 'logistic regression', '近音'],
  ['logistic reversion', 'logistic regression', '近音'],
  ['logistic progression', 'logistic regression', '近音'],
  ['super vector machine', 'support vector machine', '弱读'],
  ['super vectors', 'support vectors', '弱读'],
  ['super vector', 'support vector', '弱读'],
  ["ginny's score", 'Gini score', '外来词读音（法语 /ʒini/）'],
  ['genius purity score', 'Gini impurity score', '外来词读音'],
  ['genius score', 'Gini score', '外来词读音'],
  ['juniscore', 'Gini score', '外来词读音'],
  ['injury scope', 'Gini score', '外来词读音'],
  ['charity score', 'Gini score', '外来词读音'],
  ['insurance score', 'Gini score', '外来词读音'],
  ['biased variance', 'bias-variance', '漏读词尾'],
  ['kernel fashion', 'kernel function', '近音'],
  ['hyper plane', 'hyperplane', '切词错误'],
  ['over fitting', 'overfitting', '切词错误'],
  ['risk specification error', 'misclassification error', '近音/切词'],
  ['decision speed', 'decision split', '近音'],
];

// ---------- 匹配 ----------
export function phraseRegex(phrase, flags = 'giu') {
  // 允许 ' 与 ’ 互换；两侧要求词边界
  const body = esc(phrase.trim()).replace(/['’]/g, "['’]").replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}'’-])${body}(?![\\p{L}\\p{N}])`, flags);
}

export function matchCase(orig, repl) {
  if (!orig || !repl) return repl;
  const f = orig[0];
  if (f !== f.toLowerCase() && f === f.toUpperCase() && /[a-z]/i.test(f)) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/** 课程术语表 + 起始词表 → 规则 [{wrong,right,reason,src}] */
export function rulesFor(course, { starter = true } = {}) {
  const rules = [];
  for (const g of course?.glossary || []) {
    for (const h of g.heardAs || []) if (h && g.term && h.toLowerCase() !== g.term.toLowerCase()) rules.push({ wrong: h, right: g.term, reason: g.note || '课程术语表', src: 'glossary' });
  }
  if (starter) for (const [wrong, right, reason] of STARTER_FIXES) rules.push({ wrong, right, reason, src: 'starter' });
  return rules;
}

/** 扫描 cues，返回待确认的纠错建议（已存在于 existing 的 wrong 不重复） */
export function scanCorrections(cues, rules, existing = []) {
  const have = new Set(existing.map((c) => c.wrong.toLowerCase()));
  const found = new Map();
  // 长短语优先，避免 "super vector" 抢走 "super vector machine"
  const ordered = [...rules].sort((a, b) => b.wrong.length - a.wrong.length);
  const claimed = cues.map(() => []); // 已被更长规则占用的区间
  for (const r of ordered) {
    const key = r.wrong.toLowerCase();
    if (have.has(key) || found.has(key)) continue;
    const re = phraseRegex(r.wrong);
    const at = [];
    cues.forEach((c, k) => {
      for (const m of c.text.matchAll(re)) {
        const s = m.index, e = s + m[0].length;
        if (claimed[k].some(([a, b]) => s < b && e > a)) continue;
        claimed[k].push([s, e]);
        if (!at.includes(c.i)) at.push(c.i);
      }
    });
    if (at.length) found.set(key, { wrong: r.wrong, right: r.right, reason: r.reason, count: at.length, cues: at, state: 'pending', src: r.src });
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

/** 就地应用一条纠错到 cues；返回修改的句数 */
export function applyCorrection(cues, corr) {
  const re = phraseRegex(corr.wrong);
  const idx = new Set(corr.cues || []);
  let n = 0;
  for (const c of cues) {
    if (idx.size && !idx.has(c.i)) continue;
    re.lastIndex = 0;
    if (!re.test(c.text)) continue;
    re.lastIndex = 0;
    const before = c.text;
    c.text = before.replace(re, (m) => matchCase(m, corr.right));
    if (c.raw === undefined) c.raw = before;
    (c.fx ||= []).push({ wrong: corr.wrong, right: corr.right });
    n++;
  }
  return n;
}

/** 撤销一条纠错 */
export function revertCorrection(cues, corr) {
  const re = phraseRegex(corr.right);
  let n = 0;
  for (const c of cues) {
    const fx = c.fx?.findIndex((f) => f.wrong === corr.wrong && f.right === corr.right);
    if (fx === undefined || fx < 0) continue;
    re.lastIndex = 0;
    c.text = c.text.replace(re, (m) => matchCase(m, corr.wrong));
    c.fx.splice(fx, 1);
    if (!c.fx.length) {
      delete c.fx;
      if (c.raw && c.raw.toLowerCase() === c.text.toLowerCase()) { c.text = c.raw; delete c.raw; }
    }
    n++;
  }
  return n;
}

/** 已采纳纠错 → 词汇里的 heardAs 提示 */
export function heardAsFor(term, corrections) {
  const t = term.toLowerCase();
  return corrections.filter((c) => c.state === 'applied' && (c.right.toLowerCase() === t || c.right.toLowerCase().includes(t) || t.includes(c.right.toLowerCase()))).map((c) => c.wrong);
}
