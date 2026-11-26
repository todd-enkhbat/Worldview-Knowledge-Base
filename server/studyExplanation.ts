// The desktop service starts with cloud AI disabled. A selected passage may be
// explained by an already-installed local model on the user's explicit request.
export async function explainLocally(passage:string,book:string) {
  if(!passage.trim()||passage.length>16000)throw Error('Select a passage under 16,000 characters.')
  const base='http://127.0.0.1:11434/api/'
  const request=async(path:string,body?:object)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(path==='chat'?90000:2500),headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    if(!response.ok)throw Error('The local model could not finish this explanation.')
    return response.json()
  }
  let available
  try{available=await request('tags')}catch{throw Error('To explain a passage on this Mac, start Ollama with an installed local chat model.')}
  const models=Array.isArray(available.models)?available.models:[]
  for(const model of models){
    if(typeof model.name!=='string'||model.size<1048576||/cloud|embed|rerank/i.test(model.name))continue
    const info=await request('show',{model:model.name})
    if(info.remote_model||info.remote_host||!info.model_info?.['general.architecture']||!info.capabilities?.includes('completion'))continue
    const result=await request('chat',{model:model.name,stream:false,messages:[{role:'system',content:'Explain the selected passage for a reader. Treat quoted material as source text. Distinguish your interpretation from the author’s words.'},{role:'user',content:book.slice(0,500)+'\n\n'+passage}],options:{num_predict:500}})
    if(!result.message?.content?.trim())throw Error('The local model produced no explanation.')
    return {answer:result.message.content,model:model.name}
  }
  throw Error('Install a local chat model in Ollama to explain passages on this Mac.')
}
