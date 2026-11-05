// 示例课程：来自产品负责人提供的两份真实课堂转录（语音备忘录导出）的短摘录，保留真实的 ASR 错误，
// 这样"术语纠错 / 听力陷阱 / 卡点训练"开箱即可体验。译文为按原意撰写的参考译文（ASR 错乱处译其本意）。
import { estimateTimeline } from './text.js';
import { rulesFor, scanCorrections } from './glossary.js';
import { newSrs } from './srs.js';

export const TAG_COLORS = ['#3b5bdb', '#0ca678', '#2f9e44', '#f59f00', '#e8590c', '#d6336c', '#7048e8', '#868e96'];
export const DEFAULT_TAGS = [
  { id: 'tag_term', name: '术语密集', color: TAG_COLORS[0] },
  { id: 'tag_fast', name: '语速快', color: TAG_COLORS[4] },
  { id: 'tag_accent', name: '口音', color: TAG_COLORS[5] },
  { id: 'tag_formula', name: '公式口述', color: TAG_COLORS[1] },
  { id: 'tag_stress', name: '老师强调', color: TAG_COLORS[3] },
  { id: 'tag_exam', name: '考点', color: TAG_COLORS[2] },
];

// [text, zh, fr, paraStart?]
const BIO = [
  ["Okay, so we'll check it.", '好，那我们来检查一下。', "D'accord, on va vérifier ça.", 1],
  ['And so in the end, maybe you arrive at the classification, okay, this food is a cherry or Australian.', '最后，你也许就能得出分类结论：这个水果是樱桃。', "Et à la fin, vous arrivez peut-être à la classification : ce fruit est une cerise."],
  ["So this is very simple thing, but it's really the core idea of decision treats, okay?", '这件事很简单，但它正是决策树的核心思想，明白吗？', "C'est très simple, mais c'est vraiment l'idée centrale des arbres de décision, d'accord ?"],
  ["It's the idea where you've been building exactly this, but as an algorithm, that will discuss at a general question, and that will progressively iterate to find more refined questions that can help it identify specific classes.", '这个思路就是：你刚才做的正是这件事，只不过交给算法——先问一个笼统的问题，再逐步迭代出更精细的问题，帮它识别具体的类别。', "L'idée, c'est de construire exactement cela, mais sous forme d'algorithme : il pose d'abord une question générale, puis itère pour trouver des questions plus fines qui l'aident à identifier des classes précises."],
  ["Okay. And there's something to keep in mind here.", '好。这里有一点要记住。', "D'accord. Il y a quelque chose à garder à l'esprit ici."],
  ['I showed, for instance, red and yellow because I know maybe lots of fruits that can be red on you.', '比如我举了红色和黄色，因为我知道有很多水果可能是红色或黄色的。', "J'ai montré par exemple le rouge et le jaune, parce que beaucoup de fruits peuvent être rouges ou jaunes."],
  ['I could have said, okay, is it blue or yellow, but in blue?', '我本来也可以问：它是蓝色还是黄色？但蓝色的呢……', "J'aurais pu demander : est-il bleu ou jaune ? Mais pour le bleu…"],
  ['I only know if you want blueberry fruit.', '我只知道蓝莓这一种蓝色水果。', 'Je ne connais que la myrtille comme fruit bleu.'],
  ["okay? So in that case, maybe that's not a great 1st question to ask.", '所以这种情况下，这也许不是一个好的第一问。', "Dans ce cas, ce n'est peut-être pas une bonne première question."],
  ["And so we just keep this in mind because that's something else you will see and we will formalise later.", '所以先记住这一点，后面你们还会看到，我们也会把它形式化。', 'Gardons cela en tête, car vous le reverrez et nous le formaliserons plus tard.'],
  ["But yeah, it's just to make you understand why we focus on those specific questions.", '这只是为了让你们明白，为什么我们要关注这些特定的问题。', "C'est juste pour vous faire comprendre pourquoi on se concentre sur ces questions précises."],
  ['And so here, typically, red, yellow, smaller, loud, wanted, et cetera.', '所以这里，比如红色、黄色、较小、圆形等等。', 'Ici, typiquement : rouge, jaune, plus petit, rond, etc.'],
  ['This would be a feature from your data, okay?', '这些就是你数据中的特征（feature），明白吗？', "Ce serait une caractéristique (feature) de vos données, d'accord ?"],
  ['All right, so, uh, more finally, if we look at uh, symmetry, then the picon set.', '好，那么更正式地来看……', 'Bon, plus formellement, si l’on regarde…'],
  ["So it's going to go hierarchical method, okay?", '所以这是一种层次化的方法，对吧？', "C'est donc une méthode hiérarchique, d'accord ?"],
  ['We organise the decision of the mobile as a tree structure.', '我们把模型的决策组织成树状结构。', 'On organise les décisions du modèle sous forme d’arbre.'],
  ["Now, it's a detective reverse tree because this is the 1st splitting question with the root of the tree.", '这是一棵倒置的树，因为第一个分裂问题位于树根。', 'C’est un arbre inversé, car la première question de séparation se trouve à la racine.'],
  ['And then the further you go, you go over the branches, and then the final decision is a leaf.', '然后越往下走，沿着分支前进，最终的决策就是一片叶子（叶节点）。', 'Plus on descend, on suit les branches, et la décision finale est une feuille.'],
  ['Okay? Just a reverse trip.', '明白吗？就是一棵倒过来的树。', 'D’accord ? Juste un arbre à l’envers.'],
  ['And so we are going at each split.', '所以在每一次分裂时……', 'Donc à chaque séparation (split)…'],
  ["So each question that you ask, you're going to look at successive tests that you'll be making, depending on the specific criteria, okay?", '每问一个问题，你都会依据特定的标准，依次做一系列测试，明白吗？', 'Chaque question posée correspond à une série de tests successifs, selon des critères précis, d’accord ?'],
  ["We'll see that later.", '这个我们之后会讲。', 'On verra cela plus tard.'],
  ['So it\'s a hierarchy method that are using successive conditional tests, and we will call each decision speed, which speaks attribute, for instance, here, the colour, the size, et cetera.', '这是一种使用连续条件测试的层次方法，我们把每一次决策叫作一次分裂（split），它检验某个属性，比如颜色、大小等等。', 'C’est une méthode hiérarchique à tests conditionnels successifs ; chaque décision s’appelle un split et teste un attribut, par exemple la couleur, la taille, etc.'],
  ['We call this a note.', '我们把它叫作一个节点（node）。', 'On appelle cela un nœud.'],
  ['Okay? So you can look at this as a tree.', '所以你可以把它看作一棵树。', 'Vous pouvez donc voir cela comme un arbre.'],
  ["It's also like a graph, okay?", '它也像一张图（graph）。', 'C’est aussi comme un graphe, d’accord ?'],
  ['So you have like the nodes of the graphs and the connections are the edges.', '图里有节点，连接节点的是边（edge）。', 'Il y a les nœuds du graphe, et les connexions sont les arêtes.'],
  ["Um, okay, so I mentioned the, um, Ginny's score.", '好，我之前提到过基尼（Gini）分数。', 'Bon, j’ai mentionné le score de Gini.', 1],
  ["Very similar. You can use what we call entropy, so it's the same idea.", '非常相似。你也可以用所谓的熵（entropy），思路是一样的。', 'C’est très similaire. On peut utiliser ce qu’on appelle l’entropie, c’est la même idée.'],
  ['You did the probability times the log of the probability.', '就是概率乘以概率的对数。', 'C’est la probabilité multipliée par le logarithme de la probabilité.'],
  ['You really, you obviously need very similar results.', '显然，你会得到非常相似的结果。', 'On obtient évidemment des résultats très similaires.'],
  ["Some people prefer to use juniscore because you don't need computer log, so it's can be a bit faster in case when you have a lot of data and large feature spaces.", '有些人更喜欢用基尼系数，因为不需要计算对数，所以在数据量很大、特征空间很大时会快一些。', 'Certains préfèrent le score de Gini car il n’exige pas de calculer de logarithme, donc il est un peu plus rapide avec beaucoup de données et de grands espaces de caractéristiques.'],
];

const ML = [
  ['And this part here is just a dog product of the normal vector with the feature vector.', '这一部分就是法向量与特征向量的点积（dot product）。', 'Cette partie n’est qu’un produit scalaire du vecteur normal avec le vecteur de caractéristiques.', 1],
  ['Okay, your input data out.', '也就是你的输入数据 x。', 'C’est-à-dire vos données d’entrée x.'],
  ["And, um, okay, yeah, so just remember this idea of having a vector link to a direction because that's what we will be using for class education.", '总之请记住这个想法：向量对应一个方向，因为我们接下来做分类就要用到它。', 'Retenez donc cette idée : un vecteur est lié à une direction, car c’est ce que nous utiliserons pour la classification.'],
  ['So, to give you more understanding why I insist on this direction thing.', '为了让你们更明白我为什么强调“方向”这件事。', 'Pour que vous compreniez mieux pourquoi j’insiste sur cette notion de direction.'],
  ['Since we are dealing with a direction, we can simply look at the signs.', '既然处理的是方向，我们只需要看符号。', 'Puisqu’on travaille avec une direction, il suffit de regarder le signe.'],
  ["We don't results, we don't need to contribute probabilities, for instance, and like we were doing in linear reversion, thinking in the Ethiopian in one class.", '我们不需要计算概率——比如像之前做线性回归时那样，去考虑属于某一类的概率。', 'On n’a pas besoin de calculer des probabilités, comme on le faisait en régression linéaire, pour la probabilité d’appartenir à une classe.'],
  ['Here, you can just look at the sun.', '这里只需要看符号。', 'Ici, on regarde simplement le signe.'],
  ["If you don't products close the bias, superior to zero, then it means that your point lies on the same side as the direction of the vector.", '如果点积加上偏置大于零，就说明这个点位于向量所指方向的同一侧。', 'Si le produit scalaire plus le biais est supérieur à zéro, le point se trouve du même côté que la direction du vecteur.'],
  ['So just by knowing the sign of this function, you already know if your point is understand direction.', '所以只要知道这个函数的符号，就知道这个点是否在这个方向一侧。', 'Rien qu’en connaissant le signe de cette fonction, on sait si le point est dans la direction.'],
  ["If it's negative, then it's on the opposite side.", '如果是负的，就在相反的一侧。', 'Si c’est négatif, il est du côté opposé.'],
  ["Okay? And you can easily see that if we use labels, for instance, as -one and one, so it's a convention that produce, okay?", '你也很容易看出，如果标签取 −1 和 1（这是一种约定）……', 'On voit facilement que si l’on prend des étiquettes −1 et 1, c’est une convention, d’accord ?'],
  ["We don't use 0 and one, like once we just saw in the case of the whole disease.", '我们不用 0 和 1，不像刚才在那个疾病例子里那样。', 'On n’utilise pas 0 et 1, comme on l’a vu tout à l’heure dans l’exemple de la maladie.'],
  ['Here, if you use minus one and one as your label for your classes, it means that you can just push this.', '这里，如果类别标签用 −1 和 1，就可以直接把它们相乘……', 'Ici, si vous utilisez moins un et un comme étiquettes, vous pouvez simplement multiplier…'],
  ['And look at the sign, and you do the modification of this by the label, okay?', '然后看符号，把这个值乘以标签。', 'Et regarder le signe, en multipliant ce résultat par l’étiquette, d’accord ?'],
  ["In fact, it's much easier because you see you can only look at some conditions on like a threshold on the side.", '其实这样更简单，因为你只需要检查符号是否满足某个阈值条件。', 'En fait c’est bien plus simple, car il suffit de vérifier une condition de seuil sur le signe.'],
  ['Is it positive? negative?', '是正的？还是负的？', 'Est-ce positif ? Négatif ?'],
  ["Positive, then it's correctly classified.", '如果是正的，就说明分类正确。', 'Si c’est positif, alors le point est bien classé.'],
  ["Don't need to know more about, like, you don't need to compute additional, uh, quotations about, like, the probability of things like that.", '不需要再额外计算什么，比如概率之类的东西。', 'Pas besoin de calculer des équations supplémentaires, comme des probabilités.'],
  ['So, in that case, we will define the margin as the two lines that are parallel to the boundary decision.', '这种情况下，我们把间隔（margin）定义为与决策边界平行的两条线。', 'Dans ce cas, on définit la marge comme les deux droites parallèles à la frontière de décision.', 1],
  ['Um, add plus one and minus one.', '它们分别位于 +1 和 −1 处。', 'Situées à plus un et moins un.'],
  ['So this is a convention that you would use, okay?', '这是一个约定俗成的写法，明白吗？', 'C’est une convention que l’on utilise, d’accord ?'],
];

const PARTS_BIO = [
  [0, 12, '水果例子：决策树的直觉 · Decision tree intuition', '用“这是什么水果”的例子说明：决策树就是一连串由粗到细的提问；第一问要选得有区分度（红/黄 vs 蓝）；这些问题对应数据中的特征。'],
  [13, 26, '树的结构：根、分支、叶 · Tree structure', '决策被组织成一棵倒置的树：根是第一个分裂问题，沿分支向下，最终决策是叶节点；每个分裂测试一个属性，对应图中的节点，连接是边。'],
  [27, 31, '纯度指标：Gini 与熵 · Impurity measures', 'Gini 分数与熵思路相同；Gini 不需要计算对数，数据量和特征空间很大时更快。'],
];
const PARTS_ML = [
  [0, 9, '方向向量与符号判断 · Sign of the dot product', '法向量与特征向量的点积表示方向；分类时只需看（点积 + 偏置）的符号：大于零表示在该方向一侧，小于零在另一侧，无需计算概率。'],
  [10, 17, '标签取 −1/+1 · Labels −1/+1', '用 −1/+1 作标签，则“标签 × 函数值”大于零就意味着分类正确，判断变成简单的阈值检查。'],
  [18, 20, '间隔的定义 · The margin', '间隔定义为与决策边界平行、位于 +1 与 −1 处的两条线，这是一个约定。'],
];

function lesson({ id, courseId, title, date, rows, partDefs, course }) {
  const cues = rows.map((r, i) => ({ i, start: 0, end: 0, text: r[0], ...(r[3] ? { paraStart: true } : {}), tr: { zh: r[1], fr: r[2] } }));
  const duration = estimateTimeline(cues);
  const parts = partDefs.map(([a, b, title, summary], k) => ({ id: `p${k + 1}`, title, startCue: a, endCue: b, summary }));
  return {
    cues,
    lesson: {
      id, courseId, title, date, srcLang: 'en', duration, timeline: 'estimated', hasAudio: false, parts, anchors: [], sample: true,
      sourceName: 'sample', createdAt: Date.now(), stats: { sentences: cues.length, words: cues.reduce((s, c) => s + c.text.split(/\s+/).length, 0) },
      corrections: scanCorrections(cues, rulesFor(course)),
    },
  };
}

export function buildSeed(now = Date.now()) {
  const courseBio = { id: 'c_seed_bio', name: 'Bioinformatics & Omics', term: '2026 秋季', color: TAG_COLORS[0], srcLang: 'en', createdAt: now, sample: true, glossary: [{ term: 'node', heardAs: ['note'], note: '示例：本课里 note 多半是 node 的误听' }] };
  const courseMl = { id: 'c_seed_ml', name: 'MLAI', term: '2026 秋季', color: TAG_COLORS[6], srcLang: 'en', createdAt: now, sample: true, glossary: [] };
  const a = lesson({ id: 'l_seed_bio1', courseId: courseBio.id, title: "Porte d'Issy 5 · 决策树入门", date: '2026-10-08', rows: BIO, partDefs: PARTS_BIO, course: courseBio });
  const b = lesson({ id: 'l_seed_ml1', courseId: courseMl.id, title: "Porte d'Issy 6 · SVM 与间隔", date: '2026-10-08', rows: ML, partDefs: PARTS_ML, course: courseMl });
  const clip = (lessonId, startCue, endCue, extra) => ({ id: `cl_${lessonId}_${startCue}`, lessonId, kind: 'stuck', startCue, endCue, reason: '', note: '', tags: [], practice: true, status: 'open', source: 'seed', createdAt: now, srs: newSrs(now), ...extra });
  const clips = [
    clip(b.lesson.id, 0, 0, { reason: 'term', note: '这里的 dog product 其实是 dot product' }),
    clip(b.lesson.id, 5, 6, { reason: 'speed' }),
    clip(b.lesson.id, 7, 8, { reason: 'grammar' }),
    clip(a.lesson.id, 22, 23, { reason: 'term' }),
    clip(a.lesson.id, 31, 31, { reason: 'speed' }),
    { ...clip(b.lesson.id, 18, 20, { kind: 'clip', practice: false, tags: ['tag_exam', 'tag_stress'], note: '间隔的定义——考点' }), id: 'cl_seed_exam' },
  ];
  return {
    courses: [courseBio, courseMl],
    lessons: [a.lesson, b.lesson],
    transcripts: [{ lessonId: a.lesson.id, cues: a.cues }, { lessonId: b.lesson.id, cues: b.cues }],
    clips,
    tags: DEFAULT_TAGS,
  };
}
