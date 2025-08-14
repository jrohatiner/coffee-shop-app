export const toast = ({ title, description, variant='default' }:{title:string;description?:string;variant?:'default'|'destructive'}) => {
  const tag = variant==='destructive' ? '❌' : '✅'
  console.log(`${tag} ${title}${description?': '+description:''}`)
}
