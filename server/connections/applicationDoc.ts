// Keep a tab link intact. Drive's plain-text export can return the first tab
// even when the user identified a different one.
export function docTarget(value:string) {
  const url=new URL(value)
  const id=/^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1]
  const tab=url.searchParams.get('tab')??''
  if(url.origin!=='https://docs.google.com'||!id||tab&&!/^t\.[A-Za-z0-9_-]+$/.test(tab))throw Error('Choose a Google Docs document or tab link.')
  return {id,tab,source:'https://docs.google.com/document/d/'+id+'/edit'+(tab?'?tab='+encodeURIComponent(tab):'')}
}
interface Element {paragraph?:{elements?:{textRun?:{content?:string}}[]};table?:{tableRows?:{tableCells?:{content?:Element[]}[]}[]}}
interface Tab {tabProperties?:{tabId?:string;title?:string};documentTab?:{body?:{content?:Element[]}};childTabs?:Tab[]}
function text(elements:Element[]):string {
  return elements.map(el=>el.paragraph?.elements?.map(e=>e.textRun?.content??'').join('')??el.table?.tableRows?.map(row=>row.tableCells?.map(cell=>text(cell.content??[])).join('\t')).join('\n')??'').join('')
}
export function extractApplicationTab(data:{title:string;tabs?:Tab[]},tabId:string) {
  function find(tabs:Tab[]):Tab|undefined {for(const tab of tabs){if(!tabId||tab.tabProperties?.tabId===tabId)return tab;const nested=find(tab.childTabs??[]);if(nested)return nested}}
  const tab=find(data.tabs??[])
  if(!tab)throw Error('This tab is unavailable. Open the document and copy the tab link again.')
  const result=text(tab.documentTab?.body?.content??[])
  if(result.length>100000)throw Error('This tab exceeds 100,000 characters. Choose a smaller tab or paste the application section.')
  return {title:tab.tabProperties?.title&&tab.tabProperties.title!=='Tab 1'?tab.tabProperties.title:data.title,text:result}
}
