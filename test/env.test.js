import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

test('从 .env 初始化密码，显式环境变量优先且配置只保存哈希', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'cinema-env-'))
  const server=path.resolve('server/index.js')
  await writeFile(path.join(dir,'.env'),'ADMIN_PASSWORD=env-file-password\nCOOKIE_SECURE=false\n')
  try {
    for (const scenario of [{file:'123456',data:'file'},{file:'new-env-password',data:'file',old:'123456'},{file:'env-file-password',data:'override',override:'environment-password'}]) {
      await writeFile(path.join(dir,'.env'),`ADMIN_PASSWORD=${scenario.file}\nCOOKIE_SECURE=false\n`)
      const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
      const data=path.join(dir,scenario.data);await mkdir(data,{recursive:true})
      const env={...process.env,SITE_PASSWORD:'654321',DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test'};delete env.ADMIN_PASSWORD
      if(scenario.override)env.ADMIN_PASSWORD=scenario.override
      const child=spawn(process.execPath,[server],{cwd:dir,env,stdio:'ignore'});const base=`http://127.0.0.1:${port}`
      try {
        for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
        const password=scenario.override || scenario.file
        if(scenario.old){const old=await fetch(base+'/api/admin/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:scenario.old})});assert.equal(old.status,401)}
        const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200)
        const site=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'654321'})});assert.equal(site.status,200)
        const saved=await readFile(path.join(data,'config.json'),'utf8');assert.ok(!saved.includes(password));assert.equal(typeof JSON.parse(saved).password.hash,'string')
      } finally {child.kill();await new Promise(r=>child.once('exit',r))}
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('两种密码少于 6 个字符时拒绝启动', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'cinema-short-password-'))
  try {
    for (const [admin,site] of [['12345','123456'],['123456','12345']]) {
      const result=spawnSync(process.execPath,[path.resolve('server/index.js')],{cwd:dir,env:{...process.env,DATA_DIR:path.join(dir,admin+site),ADMIN_PASSWORD:admin,SITE_PASSWORD:site},encoding:'utf8',timeout:5000})
      assert.equal(result.status,1);assert.match(result.stderr,/至少 6 个字符/)
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})
