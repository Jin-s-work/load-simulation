// 컨테이너의 진입점.
//
// CLUSTER_WORKERS 가 1 이면 지금까지와 똑같이 단일 프로세스로 돈다.
// 2 이상이면 Node 의 cluster 모듈로 워커를 그만큼 띄운다.
//
// ── 여기서 반드시 처리해야 하는 함정 ────────────────────────────────────────
// 워커가 N 개면 프로세스가 N 개이고, 각자 자기 지표를 따로 센다.
// 그런데 /metrics 는 포트 3000 하나이고, 커널이 요청을 워커들에게 나눠준다.
// 그대로 두면 Prometheus 가 긁을 때마다 **아무 워커 하나의 지표**만 받게 되어
// "요청 수가 1/N 로 보이는" 완전히 틀린 값이 된다.
//
// 해결: 워커마다 자기 전용 지표 포트(3010 + worker.id)를 하나 더 연다.
// Prometheus 가 각 워커를 따로 긁고, 질의할 때 sum() 으로 합친다.
//
// (처음엔 prom-client 의 AggregatorRegistry 로 프라이머리가 IPC 수집하게 했으나
//  워커 응답이 오지 않아 타임아웃했다. 원인을 더 파는 대신 포트를 나누는 쪽으로 갔다.
//  부수 효과로 **워커별 루프 지연을 따로 볼 수 있게 되어** 오히려 분석에 유리하다.)
// ---------------------------------------------------------------------------

import cluster from 'node:cluster';

const WORKERS = Math.max(1, Number(process.env.CLUSTER_WORKERS ?? 1));

if (WORKERS > 1 && cluster.isPrimary) {
  process.stdout.write(`primary pid=${process.pid} forking ${WORKERS} workers\n`);

  for (let i = 0; i < WORKERS; i += 1) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    process.stderr.write(`worker ${worker.process.pid} died (code=${code} signal=${signal})\n`);
    // 종료 중이 아니면 되살린다. 이게 없으면 워커가 죽을 때마다 용량이 줄어든다.
    if (!shuttingDown) cluster.fork();
  });

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // 워커에게 신호를 전달하고, 워커들이 각자 graceful shutdown 을 하도록 둔다.
      for (const id of Object.keys(cluster.workers)) {
        cluster.workers[id]?.process.kill(signal);
      }
      setTimeout(() => process.exit(0), 15000).unref();
    });
  }
} else {
  // 워커(또는 단일 프로세스 모드)
  await import('./server.js');
}
