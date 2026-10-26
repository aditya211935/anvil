using System.Collections.Generic;
using System.Web.Http;

namespace Acme.Catalog.Legacy
{
    // ASP.NET Web API 2, convention-routed: the verb comes from the action name
    // prefix and the path from the MapHttpRoute template in App_Start/WebApiConfig.cs.
    public class ProductsController : ApiController
    {
        public IEnumerable<string> GetAllProducts()
        {
            return new string[0];
        }

        public IHttpActionResult GetProduct(int id)
        {
            return Ok();
        }

        public void PutProduct(int id, [FromBody] string value)
        {
        }

        public void DeleteProduct(int id)
        {
        }
    }
}
