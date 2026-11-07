// Self-consistency (B1), quote verification (B2) and dataset sanity (C1). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, evaluateConversation, sampleCount } from "./evaluate.js";
import { extractQuotes, quoteFlags } from "./validate.js";
import { compositionWarnings } from "../eval/dataset.js";

const binary = { id: "c01", type: "binary", title: "t", description: "d", na_allowed: false };
const scale = { id: "c02", type: "scale", title: "t", description: "d", scale: [{ value: 0 }, { value: 5 }, { value: 10 }] };
const yes = (e) => ({ criterion_id: "c01", answer: "yes", scale_value: null, explanation: e, evidence_ids: ["m001"], checked_range: null });
const no = (e) => ({ criterion_id: "c01", answer: "no", scale_value: null, explanation: e, evidence_ids: [], checked_range: { from: "m001", to: "m001" } });
const sc = (v) => ({ criterion_id: "c02", answer: null, scale_value: v, explanation: `v${v}`, evidence_ids: ["m001"], checked_range: null });

test("aggregate keeps the majority binary answer with a real sample's explanation", () => {
  const r = aggregate(binary, [no("a"), yes("b"), yes("c")]);
  assert.equal(r.answer, "yes");
  assert.equal(r.explanation, "b");
  assert.deepEqual(r.consistency, { samples: 3, agree: 2 });
});

test("aggregate resolves scale ties by lower median that stays on the scale", () => {
  assert.equal(aggregate(scale, [sc(10), sc(0)]).scale_value, 0);
  assert.equal(aggregate(scale, [sc(5), sc(10), sc(5)]).scale_value, 5);
});

test("sampleCount accepts 1..5 and falls back to one sample", () => {
  assert.equal(sampleCount(3), 3);
  assert.equal(sampleCount(0), 1);
  assert.equal(sampleCount("x"), 1);
});

test("evaluateConversation runs N samples with temperature on extra ones and votes", async () => {
  const seen = [];
  const answers = ["no", "yes", "yes"];
  const provider = {
    async generate(req) {
      seen.push(req.temperature ?? 0);
      const answer = answers[seen.length - 1];
      return {
        text: JSON.stringify({ results: [{ criterion_id: "c01", answer, scale_value: null,
          explanation: `ответ ${answer}`, evidence_ids: ["m001"], checked_from: "m001", checked_to: "m001" }] }),
        input_tokens: 1, output_tokens: 1,
      };
    },
  };
  const conv = { conversation_id: "x", messages: [{ speaker: "operator", text: "Здравствуйте", timestamp: "00:00" }] };
  const { results, calls } = await evaluateConversation(conv, [binary], {}, { provider, noCache: true, samples: 3 });
  assert.equal(results[0].answer, "yes");
  assert.equal(results[0].consistency.agree, 2);
  assert.equal(calls.length, 3);
  assert.equal(seen.filter((t) => t > 0).length, 2);
});

test("quoteFlags flags invented quotes and unknown ids but not real or translated ones", () => {
  const conv = { language: "RU", messages: [
    { id: "m001", text: "Добрый день, меня зовут Айгерим, чем могу помочь?" },
    { id: "m002", text: "Хочу открыть брокерский счёт" },
  ] };
  assert.deepEqual(quoteFlags(yes("Оператор сказал «меня зовут Айгерим, чем могу помочь» (m001)."), conv), []);
  const flags = quoteFlags(yes("Оператор написал «гарантирую доходность двадцать процентов» в m009."), conv);
  assert.equal(flags.length, 2);
  const en = { language: "EN", messages: [{ id: "m001", text: "Hello, how can I help you today?" }] };
  assert.deepEqual(quoteFlags(yes("Оператор спросил «чем я могу вам помочь сегодня» (m001)."), en), []);
  assert.deepEqual(extractQuotes("коротко «да» и «это длинная цитата здесь»"), ["это длинная цитата здесь"]);
});

test("compositionWarnings catches a wrong organizer import", () => {
  const rec = (channel, language) => ({ channel, language });
  const prod = Array.from({ length: 10 }, () => rec("agent chat", "RU"));
  assert.deepEqual(compositionWarnings(prod, "PROD"), []);
  assert.ok(compositionWarnings([...prod, rec("voice call", "RU")], "PROD").length >= 2);
  const dev = [
    ...Array.from({ length: 30 }, () => rec("agent chat", "RU")),
    ...Array.from({ length: 5 }, () => rec("voice call", "RU")),
    ...Array.from({ length: 15 }, () => rec("agent chat", "KZ")),
    ...Array.from({ length: 15 }, () => rec("agent chat", "EN")),
  ];
  assert.deepEqual(compositionWarnings(dev, "DEV"), []);
});

test("UI shows review flags and split votes, escapes text, and stays silent otherwise", async () => {
  const { reviewNotes } = await import("../web/views.js");
  assert.equal(reviewNotes({}), "");
  assert.equal(reviewNotes({ consistency: { samples: 3, agree: 3 } }), "");
  const html = reviewNotes({ review_flags: ["<b>x</b>"], consistency: { samples: 3, agree: 2 } });
  assert.match(html, /Требует проверки/);
  assert.match(html, /2\/3/);
  assert.doesNotMatch(html, /<b>x/);
});

test('quote review catches wrong evidence and speaker while allowing client context and translated quotes',()=>{
 const conv={language:'RU',messages:[{id:'m001',speaker:'operator',text:'Здравствуйте, чем могу помочь?'},{id:'m002',speaker:'client',text:'Гарантирую доходность двадцать процентов'}]};
 assert.deepEqual(quoteFlags({explanation:'Оператор ответил клиенту «Здравствуйте, чем могу помочь».',evidence_ids:['m001']},conv),[]);
 const explanation='Оператор сообщил «гарантирую доходность двадцать процентов».';
 assert.match(quoteFlags({explanation,evidence_ids:['m001']},conv).join(),/доказательствах/);
 assert.match(quoteFlags({explanation,evidence_ids:['m002']},conv).join(),/ролью operator/);
 assert.deepEqual(quoteFlags({explanation:'Клиент сказал «гарантирую доходность двадцать процентов».',evidence_ids:['m002']},conv),[]);
 assert.deepEqual(quoteFlags({explanation:'Клиент сказал «гарантирую доходность двадцать процентов».',evidence_ids:[],checked_range:{from:'m002',to:'m002'}},conv),[]);
});
test('standalone cache includes sampling temperature and pins provider options',async()=>{
 const conv={conversation_id:'sampling-cache-regression',messages:[{id:'m001',speaker:'operator',text:'Здравствуйте',timestamp:'00:00'}]};let calls=0;
 const provider={generate:async request=>{calls++;assert.equal(request.config.samples,3);return {text:JSON.stringify({results:[yes('Здравствуйте')]}),input_tokens:1,output_tokens:1};}};
 const first={provider,config:{samples:3,sampleTemperature:0.3}};
 await evaluateConversation(conv,[binary],{},first);assert.equal(calls,3);
 await evaluateConversation(conv,[binary],{},first);assert.equal(calls,3);
 await evaluateConversation(conv,[binary],{},{provider,config:{samples:3,sampleTemperature:0.6}});assert.equal(calls,6);
});
test('partial sampling failure remains visible instead of claiming all requested votes succeeded',async()=>{
 let count=0;const provider={generate:async()=>{if(++count>1)throw Error('offline');return{text:JSON.stringify({results:[yes('real answer')]}),input_tokens:1,output_tokens:1};}};
 const response=await evaluateConversation({messages:[{id:'m001',speaker:'operator',text:'Hello',timestamp:'00:00'}]},[binary],{},{provider,samples:3,noCache:true});
 assert.equal(response.results[0].consistency.samples,1);assert.equal(response.results[0].consistency.requested,3);
 const {reviewNotes}=await import('../web/views.js');assert.match(reviewNotes(response.results[0]),/1 из 3/);
});
